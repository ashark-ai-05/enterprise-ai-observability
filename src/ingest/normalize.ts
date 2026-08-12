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
  revisionDigest = "",
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([tenantId, sourceKind, provider, sourceEventId, revisionDigest]))
    .digest("hex");
  return `sha256:${digest}`;
}

export function deriveRevisionDigest(value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `sha256:${digest}`;
}

export function toDecimalString(value: number | string, scale = 12): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 20) {
    throw new RangeError("scale must be an integer between 0 and 20");
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError("decimal value must be a finite non-negative number");
  }
  if (number >= 1e21) return expandScientific(number.toString());
  const fixed = number.toFixed(scale);
  const trimmed = fixed.replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1");
  return trimmed === "-0" ? "0" : trimmed;
}

function expandScientific(value: string): string {
  if (!/[eE]/.test(value)) return value;
  const [coefficient = "0", exponentText = "0"] = value.toLowerCase().split("e");
  const exponent = Number.parseInt(exponentText, 10);
  const [integer = "0", fraction = ""] = coefficient.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

export function normalizeTelemetryEvent(
  raw: RawTelemetryEvent,
  options: { eventId?: string; receivedAt?: Date } = {},
): CanonicalEvent {
  const semanticValue = {
    sourceEventId: raw.sourceEventId,
    tenantId: raw.tenantId,
    source: raw.source,
    identity: raw.identity,
    trace: raw.trace,
    observedAt: toIsoTimestamp(raw.observedAt),
    operation: raw.operation,
    status: raw.status ?? "unknown",
    capture: raw.capture,
    attributes: raw.attributes ?? {},
    vendor: raw.vendor,
    ...(raw.usage === undefined ? {} : { usage: raw.usage }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
  };
  const revisionDigest = deriveRevisionDigest(semanticValue);
  const event: CanonicalEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: options.eventId ?? randomUUID(),
    idempotencyKey: deriveIdempotencyKey(
      raw.tenantId,
      raw.source.kind,
      raw.source.provider,
      raw.sourceEventId,
      revisionDigest,
    ),
    revisionDigest,
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
  const semanticValue = {
    sourceFactId: raw.sourceFactId,
    tenantId: raw.tenantId,
    source: raw.source,
    grain: raw.grain,
    period: raw.period,
    principalId: raw.principalId,
    ...(raw.teamId === undefined ? {} : { teamId: raw.teamId }),
    model: raw.model,
    usage: raw.usage,
    ...(raw.output === undefined ? {} : { output: raw.output }),
    capture: raw.capture,
    vendor: raw.vendor,
  };
  const revisionDigest = deriveRevisionDigest(semanticValue);
  return periodicUsageFactSchema.parse({
    ...raw,
    schemaVersion: EVENT_SCHEMA_VERSION,
    factId: options.factId ?? randomUUID(),
    revisionDigest,
    idempotencyKey: deriveIdempotencyKey(
      raw.tenantId,
      raw.source.kind,
      raw.source.provider,
      raw.sourceFactId,
      revisionDigest,
    ),
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}
