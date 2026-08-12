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

    if (url.includes("/api/v2/threads")) {
      // The real API honours `after`/`before` (on firstSyncedAt) and `sort`. An earlier stub
      // ignored them, which masked a bug where run 2 saw no already-known threads at all.
      const query = new URL(url).searchParams;
      const after = query.get("after");
      const before = query.get("before");
      let rows = scenario.threads.filter((thread) => {
        const synced = thread.firstSyncedAt;
        if (after && (!synced || synced <= after)) return false;
        if (before && (!synced || synced >= before)) return false;
        return true;
      });
      rows = [...rows].sort((a, b) => {
        const left = a.firstSyncedAt ?? a.createdAt ?? "";
        const right = b.firstSyncedAt ?? b.createdAt ?? "";
        return query.get("sort") === "DESC" ? right.localeCompare(left) : left.localeCompare(right);
      });
      return respond(200, { threads: rows });
    }

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
      {
        id: "T-quiet",
        creatorUserID: "u",
        createdAt: daysAgo(10),
        firstSyncedAt: daysAgo(10),
        updatedAt: daysAgo(5),
      },
      {
        id: "T-active",
        creatorUserID: "u",
        createdAt: daysAgo(10),
        firstSyncedAt: daysAgo(10),
        updatedAt: NOW.toISOString(),
      },
    ];
    const { archiver, usageRequests } = await harness(scenario);

    await archiver.run();
    usageRequests.length = 0;
    await archiver.run();

    // T-quiet settled after the first capture; T-active is still accruing cost.
    expect(usageRequests).toEqual(["T-active"]);
  });

  it("re-polls a known active thread on the next run even once a sync cursor exists", async () => {
    // Regression (found in review by Codex): discovery used `after=lastFirstSyncedAt` as the only
    // candidate source. Because the real API filters on firstSyncedAt, an already-known active
    // thread vanished from run 2 and its cost was frozen at whatever run 1 captured.
    scenario.threads = [
      {
        id: "T-longrunner",
        creatorUserID: "u",
        createdAt: daysAgo(10),
        firstSyncedAt: daysAgo(10),
        updatedAt: NOW.toISOString(),
      },
    ];
    const { archiver, checkpoints, usageRequests } = await harness(scenario);

    await archiver.run();
    expect((await checkpoints.read()).lastFirstSyncedAt).toBe(daysAgo(10));

    usageRequests.length = 0;
    await archiver.run();

    expect(usageRequests).toEqual(["T-longrunner"]);
  });

  it("sweeps all history once, then bounds every later run to the live window", async () => {
    scenario.threads = [
      {
        id: "T-new",
        creatorUserID: "u",
        createdAt: daysAgo(1),
        firstSyncedAt: daysAgo(1),
        updatedAt: NOW.toISOString(),
      },
      { id: "T-past", creatorUserID: "u", createdAt: daysAgo(400), firstSyncedAt: daysAgo(400) },
    ];
    const { archiver, checkpoints, usageRequests } = await harness(scenario);

    // Run 1 is unbounded so the cold-start gap can be inventoried: T-past is seen and recorded
    // as expired, without a usage request being wasted on it.
    const first = await archiver.run();
    expect(first.threadsSeen).toBe(2);
    expect(first.usageExpired).toBe(1);
    expect(usageRequests).toEqual(["T-new"]);
    expect((await checkpoints.read()).coldStartSweepAt).toBeDefined();

    // Run 2 anchors `after` to the cliff boundary, so the long-expired thread is not re-listed.
    usageRequests.length = 0;
    const second = await archiver.run();
    expect(second.threadsSeen).toBe(1);
    expect(usageRequests).toEqual(["T-new"]);
  });

  it("re-opens a settled thread that later resumes activity", async () => {
    // Regression (review finding from Codex on PR #2): settlement stored bare thread IDs, so a
    // quiet thread that resumed was skipped forever and its cost froze at the pre-resumption value.
    const thread = {
      id: "T-resumer",
      creatorUserID: "u",
      createdAt: daysAgo(20),
      firstSyncedAt: daysAgo(20),
      updatedAt: daysAgo(5),
    };
    scenario.threads = [thread];
    const root = await mkdtemp(join(tmpdir(), "amp-archive-"));
    const routed = scenarioFetch(scenario);
    let clock = NOW;
    const archiver = new AmpArchiver({
      client: new AmpClient({ apiKey: "k", fetch: routed.fetch, sleep: async () => {} }),
      store: new FileRawStore(root),
      checkpoints: new FileCheckpointStore(join(root, "checkpoint.json")),
      now: () => clock,
    });

    await archiver.run(); // captured, and quiet long enough to settle
    routed.usageRequests.length = 0;

    await archiver.run(); // still quiet -> correctly skipped
    expect(routed.usageRequests).toEqual([]);

    // The thread resumes: newer updatedAt must void settlement.
    thread.updatedAt = new Date(NOW.getTime() + 3_600_000).toISOString();
    clock = new Date(NOW.getTime() + 7_200_000);
    const resumed = await archiver.run();

    expect(routed.usageRequests).toEqual(["T-resumer"]);
    expect(resumed.settlementsReopened).toBe(1);
  });

  it("rejects a non-positive backfill chunk instead of looping forever", () => {
    // A negative lookback moves the backfill cursor forward, so the bound is never reached and
    // the API is called indefinitely. Guarded in the constructor, not only at the CLI.
    const build = (chunk: number) =>
      new AmpArchiver({
        client: new AmpClient({ apiKey: "k", fetch: scenarioFetch(scenario).fetch }),
        store: new FileRawStore("/tmp/unused"),
        checkpoints: new FileCheckpointStore("/tmp/unused/checkpoint.json"),
        backfillChunkDays: chunk,
      });

    expect(() => build(-1)).toThrow(RangeError);
    expect(() => build(0)).toThrow(RangeError);
    expect(() => build(400)).toThrow(RangeError);
    expect(() => build(30)).not.toThrow();
  });

  it("persists the backfill checkpoint after each chunk, not only at run end", async () => {
    // A handled fetch error still lets run() finish and write once, so counting writes is the
    // only assertion that distinguishes per-chunk persistence. It matters for a hard kill
    // mid-backfill: without it, an interrupted run restarts the year-long walk from today.
    const root = await mkdtemp(join(tmpdir(), "amp-archive-"));
    const inner = new FileCheckpointStore(join(root, "checkpoint.json"));
    let writes = 0;
    const counting = {
      read: () => inner.read(),
      write: async (state: Awaited<ReturnType<typeof inner.read>>) => {
        writes += 1;
        await inner.write(state);
      },
    } as unknown as FileCheckpointStore;

    const archiver = new AmpArchiver({
      client: new AmpClient({ apiKey: "k", fetch: scenarioFetch(scenario).fetch, sleep: async () => {} }),
      store: new FileRawStore(root),
      checkpoints: counting,
      now: () => NOW,
      backfillChunkDays: 30,
    });
    await archiver.run();

    // 365 days in 30-day chunks is 13 backfill writes, plus the end-of-run write.
    expect(writes).toBeGreaterThan(10);
    const reached = new Date((await inner.read()).dailyUsageBackfilledFrom as string);
    expect(Math.round((NOW.getTime() - reached.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(365);
  });

  it("dedupes identical bodies while still logging every observation", async () => {
    scenario.threads = [
      {
        id: "T-1",
        creatorUserID: "u",
        createdAt: daysAgo(1),
        firstSyncedAt: daysAgo(1),
        updatedAt: NOW.toISOString(),
      },
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

  it("re-sweeps unfiltered after the sweep interval so threads without a sync time resurface", async () => {
    // Bounded listing relies on `firstSyncedAt`, which the schema does not guarantee. The weekly
    // sweep caps how long such a thread can stay invisible; without it the gap is unbounded.
    scenario.threads = [{ id: "T-nosync", creatorUserID: "u", createdAt: daysAgo(3) }];
    const root = await mkdtemp(join(tmpdir(), "amp-archive-"));
    const routed = scenarioFetch(scenario);
    const checkpoints = new FileCheckpointStore(join(root, "checkpoint.json"));
    let clock = NOW;
    const archiver = new AmpArchiver({
      client: new AmpClient({ apiKey: "k", fetch: routed.fetch, sleep: async () => {} }),
      store: new FileRawStore(root),
      checkpoints,
      now: () => clock,
    });

    await archiver.run();
    routed.usageRequests.length = 0;

    // A day later the bounded listing filters it out entirely.
    clock = new Date(NOW.getTime() + 86_400_000);
    await archiver.run();
    expect(routed.usageRequests).toEqual([]);

    // Past the sweep interval the unfiltered walk picks it up again.
    clock = new Date(NOW.getTime() + 8 * 86_400_000);
    await archiver.run();
    expect(routed.usageRequests).toEqual(["T-nosync"]);
  });

  it("stamps capture policy and redacted fields on every receipt", async () => {
    // A run-level count answers "did we redact anything"; an auditor needs it per stored record.
    scenario.threads = [
      { id: "T-1", creatorUserID: "u", createdAt: daysAgo(1), firstSyncedAt: daysAgo(1), updatedAt: daysAgo(1) },
    ];
    const { archiver, root } = await harness(scenario);

    await archiver.run();

    const receipts = (await readFile(join(root, "observations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((r) => r.stage === "thread-usage" || r.stage === "daily-usage");

    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(receipt.capturePolicy).toBe("metadata_only");
      expect(Array.isArray(receipt.redactedFields)).toBe(true);
    }
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
