import { createHash, randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  canonicalEventSchema,
  type CanonicalEvent,
  type RawTelemetryEvent,
} from "../contracts/events.js";
import {
  periodicUsageFactSchema,
  type PeriodicUsageFact,
  type PeriodicUsageFactInput,
} from "../contracts/usage.js";

function toIsoTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

export function deriveIdempotencyKey(
  tenantId: string,
  sourceKind: string,
  provider: string,
  sourceEventId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([tenantId, sourceKind, provider, sourceEventId]))
    .digest("hex");
  return `sha256:${digest}`;
}

export function normalizeTelemetryEvent(
  raw: RawTelemetryEvent,
  options: { eventId?: string; receivedAt?: Date } = {},
): CanonicalEvent {
  const event: CanonicalEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: options.eventId ?? randomUUID(),
    idempotencyKey: deriveIdempotencyKey(
      raw.tenantId,
      raw.source.kind,
      raw.source.provider,
      raw.sourceEventId,
    ),
    sourceEventId: raw.sourceEventId,
    tenantId: raw.tenantId,
    source: raw.source,
    identity: raw.identity,
    trace: raw.trace,
    timing: {
      observedAt: toIsoTimestamp(raw.observedAt),
      receivedAt: toIsoTimestamp(raw.receivedAt ?? options.receivedAt ?? new Date()),
    },
    operation: raw.operation,
    status: raw.status ?? "unknown",
    capture: raw.capture,
    attributes: raw.attributes ?? {},
    vendor: raw.vendor,
    ...(raw.usage === undefined ? {} : { usage: raw.usage }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
  };

  return canonicalEventSchema.parse(event);
}

export function normalizePeriodicUsageFact(
  raw: PeriodicUsageFactInput,
  options: { factId?: string } = {},
): PeriodicUsageFact {
  return periodicUsageFactSchema.parse({
    ...raw,
    schemaVersion: EVENT_SCHEMA_VERSION,
    factId: options.factId ?? randomUUID(),
    idempotencyKey: deriveIdempotencyKey(
      raw.tenantId,
      raw.source.kind,
      raw.source.provider,
      raw.sourceFactId,
    ),
  });
}
