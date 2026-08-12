import { describe, expect, it } from "vitest";
import { canonicalEventSchema } from "../src/contracts/events.js";
import {
  deriveIdempotencyKey,
  normalizeTelemetryEvent,
  toDecimalString,
} from "../src/ingest/normalize.js";

const rawEvent = {
  sourceEventId: "amp-thread-42:usage:2026-08-12T00:00:00Z",
  tenantId: "tenant-a",
  source: { kind: "amp" as const, provider: "ampcode" },
  identity: { principalId: "user-1", actorType: "human" as const, teamId: "team-a" },
  trace: { runId: "thread-42", traceId: "trace-42", spanId: "usage-1" },
  observedAt: "2026-08-12T00:00:00+00:00",
  receivedAt: "2026-08-12T00:00:01+00:00",
  operation: "model_call" as const,
  status: "succeeded" as const,
  capture: {
    mode: "metadata_only" as const,
    contentIncluded: false,
    redaction: "not_applicable" as const,
    policyVersion: "policy-1",
  },
  usage: {
    inputTokens: 100,
    outputTokens: 25,
    providerReportedCost: { amount: "0.0125", currency: "USD" },
  },
  model: { provider: "anthropic", name: "example-model" },
  vendor: { namespace: "amp.v2", attributes: { threadId: "thread-42" } },
};

describe("canonical event contract", () => {
  it("normalizes a raw provider event and applies deterministic idempotency", () => {
    const event = normalizeTelemetryEvent(rawEvent, {
      eventId: "00000000-0000-4000-8000-000000000001",
    });

    expect(event.schemaVersion).toBe(1);
    expect(event.timing.observedAt).toBe("2026-08-12T00:00:00.000Z");
    expect(event.idempotencyKey).toBe(
      deriveIdempotencyKey(
        "tenant-a",
        "amp",
        "ampcode",
        rawEvent.sourceEventId,
        event.revisionDigest,
      ),
    );
  });

  it("rejects content in metadata-only mode", () => {
    const event = normalizeTelemetryEvent(rawEvent, {
      eventId: "00000000-0000-4000-8000-000000000001",
    });
    const parsed = canonicalEventSchema.safeParse({
      ...event,
      capture: { ...event.capture, contentIncluded: true },
    });

    expect(parsed.success).toBe(false);
  });

  it("requires model metadata for model calls", () => {
    expect(() =>
      normalizeTelemetryEvent({ ...rawEvent, model: undefined }, {
        eventId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/model_call events require model metadata/);
  });

  it("rejects receipt timestamps earlier than the observation", () => {
    expect(() =>
      normalizeTelemetryEvent({
        ...rawEvent,
        receivedAt: "2026-08-11T23:59:59+00:00",
      }),
    ).toThrow(/receivedAt cannot be earlier than observedAt/);
  });

  it("rejects nested vendor content in the metadata record", () => {
    expect(() =>
      normalizeTelemetryEvent({
        ...rawEvent,
        vendor: {
          namespace: "amp.v2",
          attributes: { messages: [{ role: "user", content: "secret" }] },
        } as never,
      }),
    ).toThrow();
  });

  it("deduplicates exact retries but assigns restated values a new key", () => {
    const morning = normalizeTelemetryEvent(rawEvent, {
      eventId: "00000000-0000-4000-8000-000000000001",
    });
    const retry = normalizeTelemetryEvent(rawEvent, {
      eventId: "00000000-0000-4000-8000-000000000002",
    });
    const evening = normalizeTelemetryEvent({
      ...rawEvent,
      usage: {
        ...rawEvent.usage,
        providerReportedCost: { amount: "9.80", currency: "USD" },
      },
    }, { eventId: "00000000-0000-4000-8000-000000000003" });

    expect(retry.idempotencyKey).toBe(morning.idempotencyKey);
    expect(evening.revisionDigest).not.toBe(morning.revisionDigest);
    expect(evening.idempotencyKey).not.toBe(morning.idempotencyKey);
  });

  it("normalizes provider numbers without exponential notation or float noise", () => {
    expect(toDecimalString(1e-7, 12)).toBe("0.0000001");
    expect(toDecimalString(0.1 + 0.2, 6)).toBe("0.3");
    expect(toDecimalString(1e21, 6)).toBe("1000000000000000000000");
  });

  it("accepts an eil retrieval event carrying an evidence workflow role", () => {
    const event = normalizeTelemetryEvent(
      {
        ...rawEvent,
        source: { kind: "eil", provider: "enterprise-intelligence-layer" },
        operation: "retrieval",
        model: undefined,
        usage: undefined,
        workflow: {
          workflowId: "wf-1",
          workflowType: "incident",
          attemptId: "attempt-1",
          stepId: "step-eil-search",
          stage: "search",
          layer: "eil",
          role: "evidence",
          links: [],
        },
        vendor: { namespace: "eil.v1", attributes: { query: "payment retry policy" } },
      },
      { eventId: "00000000-0000-4000-8000-000000000004" },
    );

    expect(event.source.kind).toBe("eil");
    expect(event.workflow?.layer).toBe("eil");
    expect(event.workflow?.role).toBe("evidence");
  });
});
