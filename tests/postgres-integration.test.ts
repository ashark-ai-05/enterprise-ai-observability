import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeTelemetryEvent } from "../src/ingest/normalize.js";
import {
  ingestEvent,
  type QueryResult,
  type SqlExecutor,
} from "../src/storage/event-store.js";
import { migrations } from "../src/storage/migrations.js";

describe("PostgreSQL ingestion", () => {
  let database: PGlite;
  let executor: SqlExecutor;

  beforeEach(async () => {
    database = new PGlite();
    for (const migration of migrations) {
      await database.exec(migration.sql);
    }
    executor = {
      async query<Row>(sql: string, parameters?: readonly unknown[]): Promise<QueryResult<Row>> {
        const result = await database.query<Row>(sql, [...(parameters ?? [])]);
        return {
          rows: result.rows,
          rowCount: result.affectedRows ?? result.rows.length,
        };
      },
    };
  });

  afterEach(async () => {
    await database.close();
  });

  it("runs every migration and preserves the first delivery", async () => {
    const event = normalizeTelemetryEvent({
      sourceEventId: "provider-event-1",
      tenantId: "tenant-a",
      source: { kind: "copilot", provider: "github" },
      identity: { principalId: "user-1", actorType: "human" },
      trace: { runId: "run-1", traceId: "trace-1", spanId: "span-1" },
      observedAt: "2026-08-12T00:00:00Z",
      receivedAt: "2026-08-12T00:00:01Z",
      operation: "tool_call",
      status: "succeeded",
      capture: {
        mode: "metadata_only",
        contentIncluded: false,
        redaction: "source",
        policyVersion: "policy-1",
      },
      vendor: {
        namespace: "github.copilot.otel",
        attributes: { toolName: "read_file" },
      },
    }, { eventId: "00000000-0000-4000-8000-000000000003" });

    await expect(ingestEvent(executor, event)).resolves.toEqual({
      recordId: event.eventId,
      inserted: true,
    });
    await expect(ingestEvent(executor, event)).resolves.toEqual({
      recordId: event.eventId,
      inserted: false,
    });

    const stored = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ai_event_receipts",
    );
    expect(stored.rows[0]?.count).toBe("1");
  });
});
