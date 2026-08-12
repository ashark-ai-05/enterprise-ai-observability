import { canonicalEventSchema, type CanonicalEvent } from "../contracts/events.js";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlExecutor {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<QueryResult<Row>>;
}

export interface PersistResult {
  recordId: string;
  inserted: boolean;
}

interface InsertedRow {
  event_id: string;
}

const insertEventSql = `
INSERT INTO ai_event_receipts (
  event_id, schema_version, tenant_id, idempotency_key, revision_digest, source_event_id,
  source_kind, source_provider, operation, status, observed_at, received_at,
  principal_id, team_id, run_id, trace_id, span_id, capture_mode,
  content_included, redaction, event
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17, $18,
  $19, $20, $21::jsonb
)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING event_id
`;

export async function ingestEvent(
  executor: SqlExecutor,
  candidate: CanonicalEvent,
): Promise<PersistResult> {
  const event = canonicalEventSchema.parse(candidate);
  const result = await executor.query<InsertedRow>(insertEventSql, [
    event.eventId,
    event.schemaVersion,
    event.tenantId,
    event.idempotencyKey,
    event.revisionDigest,
    event.sourceEventId,
    event.source.kind,
    event.source.provider,
    event.operation,
    event.status,
    event.timing.observedAt,
    event.timing.receivedAt,
    event.identity.principalId,
    event.identity.teamId ?? null,
    event.trace.runId,
    event.trace.traceId,
    event.trace.spanId,
    event.capture.mode,
    event.capture.contentIncluded,
    event.capture.redaction,
    JSON.stringify(event),
  ]);

  return {
    recordId: result.rows[0]?.event_id ?? event.eventId,
    inserted: result.rowCount === 1,
  };
}
