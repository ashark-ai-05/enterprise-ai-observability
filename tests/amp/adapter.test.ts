import { describe, expect, it } from "vitest";
import { toPeriodicUsageFacts, toThreadUsageEvents } from "../../src/amp/adapter.js";
import type { AmpDailyUsageResponse, AmpThreadUsage, RawArtifact } from "../../src/amp/types.js";
import { normalizePeriodicUsageFact, normalizeTelemetryEvent } from "../../src/ingest/normalize.js";

const CONTEXT = { tenantId: "acme", policyVersion: "capture-v1" };

const artifact = (overrides: Partial<RawArtifact> = {}): RawArtifact => ({
  key: "daily-usage/2026-08-12",
  endpoint: "/api/v2/workspace/analytics/daily-usage",
  params: {},
  httpStatus: 200,
  fetchedAt: "2026-08-12T10:00:00.000Z",
  contentHash: "a".repeat(64),
  body: {},
  bodyText: "{}",
  redactedFields: [],
  ...overrides,
});

const model = (usage: number, extra: Partial<Record<string, number>> = {}) => ({
  requests: 5,
  inputTokens: 100,
  outputTokens: 40,
  cacheReadInputTokens: 80,
  cacheCreationInputTokens: 4,
  totalTokens: 224,
  usage,
  ...extra,
});

function dailyResponse(models: Record<string, ReturnType<typeof model>>): AmpDailyUsageResponse {
  return {
    metadata: {
      startDate: "2026-08-12",
      endDate: "2026-08-12",
      activeUsers: 1,
      totalUsers: 1,
      totalUsage: 1,
    },
    data: [
      {
        date: "2026-08-12",
        users: [
          {
            user: { id: "u1", email: "dev@example.com" },
            metrics: { linesAdded: 120, linesDeleted: 30, linesModified: 12, usage: 7.5 },
            models,
          },
        ],
      },
    ],
  };
}

describe("toPeriodicUsageFacts", () => {
  it("produces one fact per date x user x model and normalizes cleanly", () => {
    const facts = toPeriodicUsageFacts(
      dailyResponse({ "claude-opus-5": model(4.2), "gpt-5": model(3.3) }),
      artifact(),
      CONTEXT,
    );

    expect(facts).toHaveLength(2);
    // The real contract must accept these unmodified.
    for (const fact of facts) expect(() => normalizePeriodicUsageFact(fact)).not.toThrow();
    expect(facts.map((f) => f.sourceFactId)).toEqual([
      "amp:daily:2026-08-12:u1:claude-opus-5",
      "amp:daily:2026-08-12:u1:gpt-5",
    ]);
  });

  it("omits per-user/day metrics rather than attributing them to a model", () => {
    // Amp reports lines and a user-day cost per USER per DAY, with no model dimension.
    // Copying them onto each model fact multiplies them; putting them on one chosen model keeps
    // sums right but invents a model association a GROUP BY would report as fact. Neither is
    // emitted (review finding from Codex on PR #2).
    const facts = toPeriodicUsageFacts(
      dailyResponse({ "claude-opus-5": model(4.2), "gpt-5": model(3.3), "haiku-4-5": model(0.1) }),
      artifact(),
      CONTEXT,
    );

    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.output === undefined)).toBe(true);
    expect(facts.every((f) => f.vendor.attributes.userDayUsageUsd === undefined)).toBe(true);
  });

  it("never places user email in hot attributes", () => {
    const facts = toPeriodicUsageFacts(dailyResponse({ m: model(1) }), artifact(), CONTEXT);

    expect(JSON.stringify(facts)).not.toContain("dev@example.com");
  });

  it("converts float cost through the shared decimal helper", () => {
    const facts = toPeriodicUsageFacts(
      dailyResponse({ tiny: model(1e-7) }),
      artifact(),
      CONTEXT,
    );

    // String(1e-7) would be "1e-7" and fail the contract's decimal regex.
    expect(facts[0]?.usage.providerReportedCost.amount).toBe("0.0000001");
    expect(() => normalizePeriodicUsageFact(facts[0] as never)).not.toThrow();
  });

  it("yields a stable idempotency key for unchanged data on a later poll", () => {
    // asOf is excluded from the revision digest, so re-polling unchanged data must dedupe.
    const response = dailyResponse({ "claude-opus-5": model(4.2) });
    const first = normalizePeriodicUsageFact(
      toPeriodicUsageFacts(response, artifact(), CONTEXT)[0] as never,
    );
    const later = normalizePeriodicUsageFact(
      toPeriodicUsageFacts(
        response,
        artifact({ fetchedAt: "2026-08-12T18:00:00.000Z" }),
        CONTEXT,
      )[0] as never,
    );

    expect(later.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("appends a new revision when the value actually changed", () => {
    const morning = normalizePeriodicUsageFact(
      toPeriodicUsageFacts(dailyResponse({ m: model(4.2) }), artifact(), CONTEXT)[0] as never,
    );
    const evening = normalizePeriodicUsageFact(
      toPeriodicUsageFacts(
        dailyResponse({ m: model(9.8) }),
        artifact({ fetchedAt: "2026-08-12T18:00:00.000Z" }),
        CONTEXT,
      )[0] as never,
    );

    expect(evening.idempotencyKey).not.toBe(morning.idempotencyKey);
  });
});

describe("toThreadUsageEvents", () => {
  const usage: AmpThreadUsage = {
    threadID: "T-abc",
    subThreadIDs: ["T-child"],
    usage: 3.75,
    models: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        requests: 5,
        inputTokens: 900,
        outputTokens: 300,
        cacheReadInputTokens: 700,
        cacheCreationInputTokens: 40,
        usage: 3.75,
      },
    ],
  };
  const thread = {
    id: "T-abc",
    creatorUserID: "u1",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    repositories: ["acme/api", "acme/web"],
  };

  it("emits one event per model bucket, not a thread total, to avoid double counting", () => {
    const bucket = usage.models[0];
    if (!bucket) throw new Error("fixture must define a model bucket");
    const events = toThreadUsageEvents(
      { ...usage, models: [bucket, { ...bucket, model: "gpt-5" }] },
      thread,
      artifact(),
      CONTEXT,
    );

    expect(events).toHaveLength(2);
    for (const event of events) expect(() => normalizeTelemetryEvent(event)).not.toThrow();
  });

  it("maps trace fields per the contract: spanId distinguishes the observation", () => {
    const [event] = toThreadUsageEvents(usage, thread, artifact(), CONTEXT);

    expect(event?.trace.runId).toBe("T-abc");
    expect(event?.trace.traceId).toBe("T-abc");
    expect(event?.trace.spanId).toBe(event?.sourceEventId);
    expect(event?.trace.spanId).not.toBe(event?.trace.runId);
  });

  it("keeps sourceEventId stable across a restatement of the same bucket", () => {
    const bucket = usage.models[0];
    if (!bucket) throw new Error("fixture must define a model bucket");
    const first = toThreadUsageEvents(usage, thread, artifact(), CONTEXT)[0];
    const grown = toThreadUsageEvents(
      { ...usage, usage: 9.9, models: [{ ...bucket, usage: 9.9 }] },
      thread,
      artifact({ contentHash: "b".repeat(64), fetchedAt: "2026-08-12T18:00:00.000Z" }),
      CONTEXT,
    )[0];

    expect(grown?.sourceEventId).toBe(first?.sourceEventId);
    // Same logical fact, changed value -> different idempotency key -> appended revision.
    expect(normalizeTelemetryEvent(grown as never).idempotencyKey).not.toBe(
      normalizeTelemetryEvent(first as never).idempotencyKey,
    );
  });

  it("records subThreadIDs and vendor repositories for downstream verification", () => {
    const [event] = toThreadUsageEvents(usage, thread, artifact(), CONTEXT);

    expect(event?.vendor.attributes.subThreadIds).toEqual(["T-child"]);
    expect(event?.vendor.attributes.repositories).toEqual(["acme/api", "acme/web"]);
  });

  it("declares metadata-only capture with no content included", () => {
    const [event] = toThreadUsageEvents(usage, thread, artifact(), CONTEXT);

    expect(event?.capture.mode).toBe("metadata_only");
    expect(event?.capture.contentIncluded).toBe(false);
  });

  it("falls back to an unknown principal when thread metadata is unavailable", () => {
    const [event] = toThreadUsageEvents(usage, undefined, artifact(), CONTEXT);

    expect(event?.identity.principalId).toBe("unknown");
    expect(event?.identity.actorType).toBe("unknown");
    expect(() => normalizeTelemetryEvent(event as never)).not.toThrow();
  });
});
