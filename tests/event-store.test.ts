import { describe, expect, it } from "vitest";
import { normalizeTelemetryEvent } from "../src/ingest/normalize.js";
import { ingestEvent, type SqlExecutor } from "../src/storage/event-store.js";

function event() {
  return normalizeTelemetryEvent({
    sourceEventId: "event-1",
    tenantId: "tenant-a",
    source: { kind: "harness", provider: "internal" },
    identity: { principalId: "service-1", actorType: "service" },
    trace: { runId: "run-1", traceId: "trace-1", spanId: "span-1" },
    observedAt: "2026-08-12T00:00:00Z",
    receivedAt: "2026-08-12T00:00:01Z",
    operation: "run",
    status: "started",
    capture: {
      mode: "metadata_only",
      contentIncluded: false,
      redaction: "not_applicable",
      policyVersion: "policy-1",
    },
    vendor: { namespace: "internal.v1", attributes: {} },
  }, { eventId: "00000000-0000-4000-8000-000000000001" });
}

describe("event store", () => {
  it("inserts the complete canonical receipt using a parameterized query", async () => {
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    const executor: SqlExecutor = {
      async query<Row>(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters === undefined ? {} : { parameters }) });
        return {
          rows: [{ event_id: event().eventId } as Row],
          rowCount: 1,
        };
      },
    };

    const result = await ingestEvent(executor, event());

    expect(result).toEqual({ recordId: event().eventId, inserted: true });
    expect(calls[0]?.sql).toContain("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING");
    expect(calls[0]?.parameters).toHaveLength(20);
  });

  it("reports duplicate delivery without replacing the immutable receipt", async () => {
    const executor: SqlExecutor = {
      async query<Row>() {
        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    await expect(ingestEvent(executor, event())).resolves.toEqual({
      recordId: event().eventId,
      inserted: false,
    });
  });
});
