import {
  periodicUsageFactSchema,
  type PeriodicUsageFact,
} from "../contracts/usage.js";
import type { PersistResult, SqlExecutor } from "./event-store.js";

interface InsertedRow {
  fact_id: string;
}

const insertUsageFactSql = `
INSERT INTO ai_periodic_usage_facts (
  fact_id, schema_version, tenant_id, idempotency_key, revision_digest, source_fact_id,
  source_kind, source_provider, grain, period_start, period_end, as_of,
  principal_id, team_id, model_provider, model_name, fact
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17::jsonb
)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING fact_id
`;

export async function ingestPeriodicUsageFact(
  executor: SqlExecutor,
  candidate: PeriodicUsageFact,
): Promise<PersistResult> {
  const fact = periodicUsageFactSchema.parse(candidate);
  const result = await executor.query<InsertedRow>(insertUsageFactSql, [
    fact.factId,
    fact.schemaVersion,
    fact.tenantId,
    fact.idempotencyKey,
    fact.revisionDigest,
    fact.sourceFactId,
    fact.source.kind,
    fact.source.provider,
    fact.grain,
    fact.period.start,
    fact.period.end,
    fact.asOf,
    fact.principalId,
    fact.teamId ?? null,
    fact.model.provider,
    fact.model.name,
    JSON.stringify(fact),
  ]);

  return {
    recordId: result.rows[0]?.fact_id ?? fact.factId,
    inserted: result.rowCount === 1,
  };
}
