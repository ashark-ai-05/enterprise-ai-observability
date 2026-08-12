# Canonical event contract

Workflow correlation and causal links are specified in
[`WORKFLOW_TRACEABILITY.md`](WORKFLOW_TRACEABILITY.md). The `workflow` envelope is optional for
backward compatibility and, when present, participates in the semantic revision digest.

The ingestion boundary exposes two deliberately separate grains.

## Operational events

`RawTelemetryEvent` is normalized and validated by `normalizeTelemetryEvent` into a `CanonicalEvent`.

Operational events require a run, trace, and span. They represent observable actions such as model calls, tool calls, retrieval, approvals, artifacts, and outcomes. Tenant, source/provider, source event identity, principal, event/receipt timestamps, capture policy, and producer-specific attributes are mandatory or explicitly classified.

`sourceEventId` is the logical provider identity. `revisionDigest` is a SHA-256 digest of the canonical semantic value, excluding generated receipt identity and receipt time. The idempotency key combines tenant, source, logical identity, and revision digest. PostgreSQL therefore deduplicates an exact retry while appending a corrected or accrued value as a new immutable observation. Readers use `ai_latest_event_receipts` (or equivalent ordering) to select the latest observation per logical identity; immutability applies to observations, not to the mutable facts they describe.

## Periodic usage facts

`PeriodicUsageFactInput` is normalized by `normalizePeriodicUsageFact` into a `PeriodicUsageFact`.

The first supported grain is `principal_day_model`. It is used for provider aggregates that have requests, tokens, cost, and optional output-volume metrics but no defensible run linkage. Adapters must not invent a run or trace ID to force aggregate data into the operational envelope.

Periodic facts require `asOf`, recording when the provider aggregate was observed. `asOf` is intentionally excluded from `revisionDigest`: polling the same value later deduplicates instead of making polling frequency drive fact-table growth. A changed aggregate produces a new digest and appends with its new `asOf`; unchanged-poll freshness remains in the collector's raw observation log. `ai_latest_periodic_usage_facts` exposes the current value while the underlying receipt table retains changed revisions.

## Thread-level usage

Thread usage is operational and run-linked, so it uses `CanonicalEvent`, not `PeriodicUsageFact`. When the provider supplies a stable thread ID but no separate tracing hierarchy, adapters use:

```text
runId   = threadId
traceId = threadId
spanId  = sourceEventId for this usage observation
```

The span ID must distinguish the observation from other actions within the thread; do not set all three fields to the same value. Provider restatements retain the same logical `sourceEventId` when they describe the same fact, and the changing semantic value produces a new `revisionDigest`.

## Decimal normalization

Adapters convert provider JSON numbers with `toDecimalString(value, scale)`. The shared helper expands exponential notation and rounds to the selected fixed scale before trimming insignificant zeroes, ensuring adapters do not invent incompatible money conversions.

## Content boundary

The normalized record accepts only flat, typed vendor attributes. Nested raw provider bodies—especially prompts, messages, responses, tool arguments, and source code—cannot enter the hot metadata record.

An adapter may attach a content-addressed `rawPayload` reference and SHA-256 digest only when the separately governed raw archive has authorized capture, encryption, retention, and access auditing. The normalized record never embeds that content.

`metadata_only` events with `contentIncluded: true` are rejected by both runtime validation and the database constraint.

## Adapter example

```ts
import { normalizeTelemetryEvent } from "enterprise-ai-observability";

const event = normalizeTelemetryEvent({
  sourceEventId: vendorEvent.id,
  tenantId,
  source: { kind: "copilot", provider: "github" },
  identity: { principalId, actorType: "human", teamId },
  trace: { runId, traceId, spanId },
  observedAt: vendorEvent.timestamp,
  operation: "tool_call",
  status: "succeeded",
  capture: {
    mode: "metadata_only",
    contentIncluded: false,
    redaction: "source",
    policyVersion: "2026-08-12",
  },
  vendor: {
    namespace: "github.copilot.otel",
    attributes: { toolName: vendorEvent.toolName },
  },
});
```
