import { randomUUID } from "node:crypto";
import type { CanonicalEvent, EventStatus, RawTelemetryEvent } from "../contracts/events.js";
import { normalizeTelemetryEvent } from "../ingest/normalize.js";
import { forwardRequest } from "./forward.js";
import { extractUsage } from "./meter.js";
import type { PriceBook } from "./pricebook.js";
import { priceUsage } from "./pricebook.js";
import {
  type Principal,
  type PrincipalRegistry,
  UnauthorizedError,
  authenticate,
} from "./principals.js";
import { type ProviderRoute, resolveRoute } from "./routes.js";
import type { GatewayEventSink } from "./sink.js";

/** Bumped whenever capture policy changes; stamped onto every emitted event. */
const CAPTURE_POLICY_VERSION = "2026-08-12.metadata-only";

const AUDIT_FAILURE_RESPONSE: GatewayResponse = {
  status: 503,
  body: JSON.stringify({ error: "audit persistence failed" }),
};

export interface GatewayDeps {
  readonly routes: readonly ProviderRoute[];
  readonly principals: PrincipalRegistry;
  readonly priceBook: PriceBook;
  readonly sink: GatewayEventSink;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface GatewayRequest {
  readonly provider: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface GatewayResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * D6: "Build a thin one. Authenticate, attribute, meter, log, forward — no
 * logic." This function is the whole gateway. It must stay boring: no
 * retries, no routing-by-content, no provider-specific special cases beyond
 * usage-shape parsing in meter.ts.
 *
 * Every call — including auth failures — is emitted as an event. A gateway
 * that only logs successes cannot answer "what fraction of AI traffic do we
 * have context for," which is the coverage metric the design docs call out
 * as the shadow-AI detector.
 *
 * Fail-closed on audit persistence: if the event sink can't record a call,
 * this returns 503 regardless of what the upstream call actually did. An
 * observability gateway that returns a normal response while silently
 * failing to record it has defeated its own purpose — better an honest
 * error than an uncounted success.
 */
export async function handleGatewayRequest(
  deps: GatewayDeps,
  request: GatewayRequest,
): Promise<GatewayResponse> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const observedAt = now();
  const trace = readTrace(request.headers, newId);

  let principal: Principal;
  try {
    principal = await authenticate(
      deps.principals,
      request.headers.authorization,
    );
  } catch (error) {
    const persisted = await emit(deps, {
      now,
      newId,
      observedAt,
      trace,
      tenantId: "unknown",
      principal: {
        principalId: "unknown",
        tenant: "unknown",
        team: undefined,
        actorType: "unknown",
      },
      provider: request.provider,
      status: "failed",
      model: undefined,
      usage: undefined,
      attributes: {
        "http.status_code": 401,
        error_class:
          error instanceof UnauthorizedError ? "unauthorized" : "auth_error",
      },
    });
    if (!persisted) return AUDIT_FAILURE_RESPONSE;
    return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  const route = resolveRoute(deps.routes, request.provider);
  if (!route) {
    const persisted = await emit(deps, {
      now,
      newId,
      observedAt,
      trace,
      tenantId: principal.tenant,
      principal,
      provider: request.provider,
      status: "failed",
      model: undefined,
      usage: undefined,
      attributes: { "http.status_code": 404, error_class: "unknown_provider" },
    });
    if (!persisted) return AUDIT_FAILURE_RESPONSE;
    return { status: 404, body: JSON.stringify({ error: "unknown provider" }) };
  }

  const result = await forwardRequest(route, request.path, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
  });

  const modelName = extractModel(request.body) ?? extractModel(result.bodyText);
  const usage = extractUsage(result.body);
  const costUsd =
    usage && modelName
      ? priceUsage(deps.priceBook, request.provider, modelName, usage)
      : undefined;

  const persisted = await emit(deps, {
    now,
    newId,
    observedAt,
    trace,
    tenantId: principal.tenant,
    principal,
    provider: request.provider,
    status:
      result.status >= 200 && result.status < 300 ? "succeeded" : "failed",
    model: modelName
      ? { provider: request.provider, name: modelName }
      : undefined,
    usage,
    attributes: {
      "http.status_code": result.status,
      "http.latency_ms": Math.round(result.latencyMs),
      ...(result.errorClass ? { error_class: result.errorClass } : {}),
      ...(costUsd !== undefined
        ? {
            "internal.cost_usd": costUsd,
            "internal.price_book_version": deps.priceBook.version,
          }
        : {}),
    },
  });
  if (!persisted) return AUDIT_FAILURE_RESPONSE;

  return { status: result.status, body: result.bodyText };
}

interface EmitInput {
  readonly now: () => Date;
  readonly newId: () => string;
  readonly observedAt: Date;
  readonly trace: {
    readonly runId: string;
    readonly traceId: string;
    readonly spanId: string;
  };
  readonly tenantId: string;
  readonly principal: Principal;
  readonly provider: string;
  readonly status: EventStatus;
  readonly model: CanonicalEvent["model"];
  readonly usage: CanonicalEvent["usage"];
  readonly attributes: Record<string, string | number | boolean>;
}

/**
 * The canonical contract rejects `model_call` events with no `model`
 * (PR #1, `canonicalEventSchema` superRefine). Rather than risk that
 * mismatch again on some future path, `operation` is derived here, once,
 * from whether a model was actually identified — never passed in by a
 * call site. Auth/routing/path-escape rejections never reach a model, so
 * they always land as `policy`; a forwarded call whose response genuinely
 * doesn't name a model (malformed upstream body, no `model` in the request
 * either) also degrades to `policy` rather than emit a schema-invalid event.
 *
 * Builds a `RawTelemetryEvent` and hands it to the real
 * `normalizeTelemetryEvent()` (PR #1) rather than constructing a
 * `CanonicalEvent` by hand — `eventId`, `idempotencyKey`, and
 * `revisionDigest` are the normalizer's job, not this gateway's.
 *
 * Returns whether persistence succeeded rather than throwing: the caller
 * decides the fail-closed response, and there is no event to emit about a
 * failure to emit (that risks looping if the sink itself is what's down),
 * so a sink failure is logged to stderr as the one exception to "log
 * everything as an event."
 */
async function emit(deps: GatewayDeps, input: EmitInput): Promise<boolean> {
  const raw: RawTelemetryEvent = {
    sourceEventId: input.newId(),
    tenantId: input.tenantId,
    source: { kind: "maas", provider: input.provider },
    identity: {
      principalId: input.principal.principalId,
      actorType: input.principal.actorType,
      ...(input.principal.team !== undefined
        ? { teamId: input.principal.team }
        : {}),
    },
    trace: input.trace,
    observedAt: input.observedAt,
    receivedAt: input.now(),
    operation: input.model ? "model_call" : "policy",
    status: input.status,
    capture: {
      mode: "metadata_only",
      contentIncluded: false,
      redaction: "not_applicable",
      policyVersion: CAPTURE_POLICY_VERSION,
    },
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    attributes: input.attributes,
    vendor: { namespace: "maas.gateway", attributes: {} },
  };
  // `eventId` is intentionally not sourced from `deps.newId` — that hook
  // exists so tests can produce readable, deterministic sourceEventId/trace
  // ids, but the canonical schema requires eventId to be a real UUID, and
  // normalizeTelemetryEvent's own default (randomUUID()) already satisfies
  // that without coupling this module to UUID generation.
  //
  // normalizeTelemetryEvent() itself throws on schema validation failure,
  // so it must be inside this try too, not just the sink write — otherwise
  // a normalization failure propagates out of handleGatewayRequest uncaught
  // instead of degrading to the fail-closed response below.
  try {
    const event = normalizeTelemetryEvent(raw, { receivedAt: input.now() });
    await deps.sink.emit(event);
    return true;
  } catch (error) {
    console.error("gateway: failed to persist audit event", error);
    return false;
  }
}

function readTrace(
  headers: Readonly<Record<string, string>>,
  newId: () => string,
): { runId: string; traceId: string; spanId: string } {
  return {
    runId: headers["x-ai-run-id"] ?? newId(),
    traceId: headers["x-ai-trace-id"] ?? newId(),
    spanId: headers["x-ai-span-id"] ?? newId(),
  };
}

function extractModel(source: string | undefined): string | undefined {
  if (!source) return undefined;
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}
