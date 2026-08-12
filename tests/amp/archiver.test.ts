import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AmpArchiver } from "../../src/amp/archiver.js";
import { AmpClient } from "../../src/amp/client.js";
import { FileCheckpointStore, FileRawStore } from "../../src/amp/store.js";
import type { AmpThreadSummary } from "../../src/amp/types.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const EMPTY_DAILY = {
  metadata: {
    startDate: "2026-08-01",
    endDate: "2026-08-12",
    activeUsers: 0,
    totalUsers: 0,
    totalUsage: 0,
  },
  data: [],
};

interface Scenario {
  threads: AmpThreadSummary[];
  /** Thread IDs the API should 404 on. */
  notAvailable?: string[];
  /** Thread IDs the API should 500 on, permanently. */
  failing?: string[];
}

/** Routes stub responses by URL so tests describe an API, not a fixed call sequence. */
function scenarioFetch(scenario: Scenario): { fetch: typeof fetch; usageRequests: string[] } {
  const usageRequests: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    const respond = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    });

    if (url.includes("/analytics/daily-usage")) return respond(200, EMPTY_DAILY);

    if (url.includes("/threads/") && url.endsWith("/usage")) {
      const id = decodeURIComponent(url.split("/threads/")[1]?.replace("/usage", "") ?? "");
      usageRequests.push(id);
      if (scenario.notAvailable?.includes(id)) return respond(404, { error: "not available" });
      if (scenario.failing?.includes(id)) return respond(500, { error: "boom" });
      return respond(200, { threadID: id, subThreadIDs: [], usage: 1, models: [] });
    }

    if (url.includes("/api/v2/threads")) return respond(200, { threads: scenario.threads });

    return respond(404, { error: "unrouted" });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, usageRequests };
}

async function harness(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "amp-archive-"));
  const routed = scenarioFetch(scenario);
  const checkpoints = new FileCheckpointStore(join(root, "checkpoint.json"));
  const archiver = new AmpArchiver({
    client: new AmpClient({
      apiKey: "k",
      fetch: routed.fetch,
      sleep: async () => {},
      maxAttempts: 2,
    }),
    store: new FileRawStore(root),
    checkpoints,
    now: () => NOW,
  });
  return { root, archiver, checkpoints, usageRequests: routed.usageRequests };
}

describe("AmpArchiver", () => {
  let scenario: Scenario;

  beforeEach(() => {
    scenario = { threads: [] };
  });

  it("fetches usage oldest-first so records nearest the 90-day cliff are captured first", async () => {
    // The ordering guarantee is the whole point: an interrupted run must have saved the data
    // that was about to become unrecoverable, not the data that had 89 days left.
    scenario.threads = [
      { id: "T-young", creatorUserID: "u", createdAt: daysAgo(2), updatedAt: daysAgo(2) },
      { id: "T-oldest", creatorUserID: "u", createdAt: daysAgo(88), updatedAt: daysAgo(88) },
      { id: "T-middle", creatorUserID: "u", createdAt: daysAgo(45), updatedAt: daysAgo(45) },
    ];
    const { archiver, usageRequests } = await harness(scenario);

    await archiver.run();

    expect(usageRequests).toEqual(["T-oldest", "T-middle", "T-young"]);
  });

  it("never requests usage for sub-threads, whose cost is rolled into the parent", async () => {
    // Double-counting spend is the worst possible failure in a cost system.
    scenario.threads = [
      { id: "T-parent", creatorUserID: "u", createdAt: daysAgo(3), updatedAt: daysAgo(3) },
      {
        id: "T-child",
        creatorUserID: "u",
        createdAt: daysAgo(3),
        updatedAt: daysAgo(3),
        mainThreadID: "T-parent",
      },
    ];
    const { archiver, usageRequests } = await harness(scenario);

    const summary = await archiver.run();

    expect(usageRequests).toEqual(["T-parent"]);
    expect(summary.usageSkippedSubThread).toBe(1);
  });

  it("does not spend a request on threads already past the cliff", async () => {
    scenario.threads = [{ id: "T-ancient", creatorUserID: "u", createdAt: daysAgo(120) }];
    const { archiver, usageRequests } = await harness(scenario);

    const summary = await archiver.run();

    expect(usageRequests).toEqual([]);
    expect(summary.usageExpired).toBe(1);
  });

  it("treats a 404 as an expiry fact, not a run failure", async () => {
    scenario.threads = [
      { id: "T-gone", creatorUserID: "u", createdAt: daysAgo(89), updatedAt: daysAgo(89) },
    ];
    scenario.notAvailable = ["T-gone"];
    const { archiver, checkpoints } = await harness(scenario);

    const summary = await archiver.run();

    expect(summary.usageExpired).toBe(1);
    expect(summary.errors).toHaveLength(0);
    expect((await checkpoints.read()).expiredThreadIds).toContain("T-gone");
  });

  it("records genuine failures as at-risk rather than swallowing them", async () => {
    scenario.threads = [
      { id: "T-flaky", creatorUserID: "u", createdAt: daysAgo(80), updatedAt: daysAgo(80) },
    ];
    scenario.failing = ["T-flaky"];
    const { archiver } = await harness(scenario);

    const summary = await archiver.run();

    expect(summary.errors).toHaveLength(1);
    expect(summary.atRiskThreadIds).toEqual(["T-flaky"]);
  });

  it("skips a settled thread on the next run but keeps polling an active one", async () => {
    scenario.threads = [
      { id: "T-quiet", creatorUserID: "u", createdAt: daysAgo(10), updatedAt: daysAgo(5) },
      { id: "T-active", creatorUserID: "u", createdAt: daysAgo(10), updatedAt: NOW.toISOString() },
    ];
    const { archiver, usageRequests } = await harness(scenario);

    await archiver.run();
    usageRequests.length = 0;
    await archiver.run();

    // T-quiet settled after the first capture; T-active is still accruing cost.
    expect(usageRequests).toEqual(["T-active"]);
  });

  it("dedupes identical bodies while still logging every observation", async () => {
    scenario.threads = [
      { id: "T-1", creatorUserID: "u", createdAt: daysAgo(1), updatedAt: NOW.toISOString() },
    ];
    const { archiver, root } = await harness(scenario);

    await archiver.run();
    const second = await archiver.run();

    expect(second.bodiesDeduped).toBeGreaterThan(0);
    const log = await readFile(join(root, "observations.jsonl"), "utf8");
    const captures = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; threadId?: string })
      .filter((entry) => entry.stage === "thread-usage" && entry.threadId === "T-1");
    expect(captures).toHaveLength(2);
  });

  it("advances the daily-usage backfill checkpoint across runs", async () => {
    const { archiver, checkpoints } = await harness(scenario);

    await archiver.run();

    const state = await checkpoints.read();
    expect(state.dailyUsageBackfilledFrom).toBeDefined();
    // 365 days of history, walked in 30-day chunks, must reach back roughly a year.
    const reached = new Date(state.dailyUsageBackfilledFrom as string);
    const daysBack = Math.round((NOW.getTime() - reached.getTime()) / 86_400_000);
    expect(daysBack).toBeGreaterThanOrEqual(365);
  });

  it("records the highest firstSyncedAt so the next run discovers only new threads", async () => {
    scenario.threads = [
      { id: "T-a", creatorUserID: "u", createdAt: daysAgo(9), firstSyncedAt: daysAgo(9) },
      { id: "T-b", creatorUserID: "u", createdAt: daysAgo(4), firstSyncedAt: daysAgo(4) },
    ];
    const { archiver, checkpoints } = await harness(scenario);

    await archiver.run();

    expect((await checkpoints.read()).lastFirstSyncedAt).toBe(daysAgo(4));
  });
});
