import { describe, expect, it } from "vitest";
import { normalizePeriodicUsageFact } from "../src/ingest/normalize.js";

describe("periodic usage facts", () => {
  it("models provider aggregates without fabricating run linkage", () => {
    const fact = normalizePeriodicUsageFact({
      sourceFactId: "amp:2026-08-11:user-1:anthropic:example-model",
      tenantId: "tenant-a",
      source: { kind: "amp", provider: "ampcode" },
      grain: "principal_day_model",
      period: {
        start: "2026-08-11T00:00:00Z",
        end: "2026-08-12T00:00:00Z",
      },
      asOf: "2026-08-12T00:05:00Z",
      principalId: "user-1",
      model: { provider: "anthropic", name: "example-model" },
      usage: {
        requests: 4,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheWriteTokens: 25,
        providerReportedCost: { amount: "0.42", currency: "USD" },
      },
      output: { linesAdded: 12, linesDeleted: 3, linesModified: 5 },
      capture: { policyVersion: "policy-1", redaction: "not_applicable" },
      vendor: { namespace: "amp.v2.daily_usage", attributes: {} },
    }, { factId: "00000000-0000-4000-8000-000000000002" });

    expect(fact.grain).toBe("principal_day_model");
    expect(fact).not.toHaveProperty("trace");
    expect(fact).not.toHaveProperty("runId");
    expect(fact.output?.linesAdded).toBe(12);
  });

  it("appends revised aggregates while deduplicating exact retries", () => {
    const base = {
      sourceFactId: "amp:2026-08-11:user-1:anthropic:example-model",
      tenantId: "tenant-a",
      source: { kind: "amp" as const, provider: "ampcode" },
      grain: "principal_day_model" as const,
      period: {
        start: "2026-08-11T00:00:00Z",
        end: "2026-08-12T00:00:00Z",
      },
      asOf: "2026-08-12T00:05:00Z",
      principalId: "user-1",
      model: { provider: "anthropic", name: "example-model" },
      usage: {
        requests: 4,
        inputTokens: 1000,
        outputTokens: 200,
        providerReportedCost: { amount: "4.20", currency: "USD" },
      },
      capture: { policyVersion: "policy-1", redaction: "not_applicable" as const },
      vendor: { namespace: "amp.v2.daily_usage", attributes: {} },
    };
    const morning = normalizePeriodicUsageFact(base);
    const retry = normalizePeriodicUsageFact(base);
    const unchangedLater = normalizePeriodicUsageFact({
      ...base,
      asOf: "2026-08-12T06:00:00Z",
    });
    const evening = normalizePeriodicUsageFact({
      ...base,
      asOf: "2026-08-12T12:00:00Z",
      usage: {
        ...base.usage,
        providerReportedCost: { amount: "9.80", currency: "USD" },
      },
    });

    expect(retry.idempotencyKey).toBe(morning.idempotencyKey);
    expect(unchangedLater.idempotencyKey).toBe(morning.idempotencyKey);
    expect(evening.idempotencyKey).not.toBe(morning.idempotencyKey);
  });
});
