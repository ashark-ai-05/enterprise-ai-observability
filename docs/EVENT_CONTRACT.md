# Canonical event contract

The ingestion boundary exposes two deliberately separate grains.

## Operational events

`RawTelemetryEvent` is normalized and validated by `normalizeTelemetryEvent` into a `CanonicalEvent`.

Operational events require a run, trace, and span. They represent observable actions such as model calls, tool calls, retrieval, approvals, artifacts, and outcomes. Tenant, source/provider, source event identity, principal, event/receipt timestamps, capture policy, and producer-specific attributes are mandatory or explicitly classified.

The idempotency key is deterministic over tenant, source kind, provider, and source event ID. PostgreSQL enforces uniqueness per tenant and preserves the first immutable receipt.

## Periodic usage facts

`PeriodicUsageFactInput` is normalized by `normalizePeriodicUsageFact` into a `PeriodicUsageFact`.

The first supported grain is `principal_day_model`. It is used for provider aggregates that have requests, tokens, cost, and optional output-volume metrics but no defensible run linkage. Adapters must not invent a run or trace ID to force aggregate data into the operational envelope.

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
