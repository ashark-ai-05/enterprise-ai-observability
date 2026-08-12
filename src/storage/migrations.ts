export interface Migration {
  id: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    id: "0001_event_receipts",
    sql: `
CREATE TABLE IF NOT EXISTS ai_event_receipts (
  event_id uuid PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  revision_digest text NOT NULL,
  source_event_id text NOT NULL,
  source_kind text NOT NULL,
  source_provider text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  principal_id text NOT NULL,
  team_id text,
  run_id text NOT NULL,
  trace_id text NOT NULL,
  span_id text NOT NULL,
  capture_mode text NOT NULL,
  content_included boolean NOT NULL,
  redaction text NOT NULL,
  event jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_event_receipts_received_after_observed
    CHECK (received_at >= observed_at),
  CONSTRAINT ai_event_receipts_metadata_has_no_content
    CHECK (capture_mode <> 'metadata_only' OR content_included = false),
  CONSTRAINT ai_event_receipts_tenant_idempotency
    UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_event_receipts_tenant_observed_idx
  ON ai_event_receipts (tenant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS ai_event_receipts_tenant_run_idx
  ON ai_event_receipts (tenant_id, run_id, observed_at);
CREATE INDEX IF NOT EXISTS ai_event_receipts_tenant_operation_idx
  ON ai_event_receipts (tenant_id, operation, observed_at DESC);
CREATE INDEX IF NOT EXISTS ai_event_receipts_tenant_source_latest_idx
  ON ai_event_receipts (tenant_id, source_kind, source_provider, source_event_id, observed_at DESC, received_at DESC);

CREATE OR REPLACE VIEW ai_latest_event_receipts AS
SELECT DISTINCT ON (tenant_id, source_kind, source_provider, source_event_id) *
FROM ai_event_receipts
ORDER BY tenant_id, source_kind, source_provider, source_event_id,
         observed_at DESC, received_at DESC, ingested_at DESC;
`,
  },
  {
    id: "0002_periodic_usage_facts",
    sql: `
CREATE TABLE IF NOT EXISTS ai_periodic_usage_facts (
  fact_id uuid PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  revision_digest text NOT NULL,
  source_fact_id text NOT NULL,
  source_kind text NOT NULL,
  source_provider text NOT NULL,
  grain text NOT NULL CHECK (grain = 'principal_day_model'),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  principal_id text NOT NULL,
  team_id text,
  model_provider text NOT NULL,
  model_name text NOT NULL,
  fact jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_periodic_usage_facts_valid_period
    CHECK (period_end > period_start),
  CONSTRAINT ai_periodic_usage_facts_tenant_idempotency
    UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_periodic_usage_facts_tenant_period_idx
  ON ai_periodic_usage_facts (tenant_id, period_start DESC);
CREATE INDEX IF NOT EXISTS ai_periodic_usage_facts_tenant_principal_idx
  ON ai_periodic_usage_facts (tenant_id, principal_id, period_start DESC);
CREATE INDEX IF NOT EXISTS ai_periodic_usage_facts_tenant_source_latest_idx
  ON ai_periodic_usage_facts (tenant_id, source_kind, source_provider, source_fact_id, as_of DESC);

CREATE OR REPLACE VIEW ai_latest_periodic_usage_facts AS
SELECT DISTINCT ON (tenant_id, source_kind, source_provider, source_fact_id) *
FROM ai_periodic_usage_facts
ORDER BY tenant_id, source_kind, source_provider, source_fact_id,
         as_of DESC, ingested_at DESC;
`,
  },
] as const;
