import type { PeriodicUsageFactInput } from "../contracts/usage.js";
import type { RawTelemetryEvent } from "../contracts/events.js";
import { toDecimalString } from "../ingest/normalize.js";
import type { AmpDailyUsageResponse, AmpThreadSummary, AmpThreadUsage, RawArtifact } from "./types.js";

/** Namespace for vendor-specific attributes, per the shared contract. */
const VENDOR_NAMESPACE = "amp";
const SOURCE_KIND = "amp" as const;
const SOURCE_PROVIDER = "ampcode";

export interface AdapterContext {
  tenantId: string;
  /** Capture policy version in force when the data was collected. */
  policyVersion: string;
  /** Redaction applied. Metadata-only collection applies none. */
  redaction?: "not_applicable" | "source" | "ingress";
}

/** `sha256:<hex>` per the contract's digest format; the archiver stores bare hex. */
function toDigest(contentHash: string): string {
  return `sha256:${contentHash}`;
}

function rawPayloadRef(artifact: RawArtifact): { ref: string; digest: string } {
  return { ref: `blobs/${artifact.contentHash.slice(0, 2)}/${artifact.contentHash}.json`, digest: toDigest(artifact.contentHash) };
}

/**
 * Maps the workspace daily rollup onto `principal_day_model` facts.
 *
 * One fact per (date × user × model).
 *
 * **Per-user/day metrics are deliberately dropped, not redistributed.** Amp reports
 * `linesAdded`/`linesDeleted`/`linesModified` and a user-day cost total per *user per day*, with
 * no model dimension. Copying them onto every model fact multiplies them; assigning them to one
 * chosen model keeps sums right but invents a model association that a `GROUP BY model` would
 * report as fact. Both produce confidently wrong numbers, so neither is emitted here. The values
 * remain in the raw archive and can be surfaced by a real `principal_day` grain later.
 *
 * User email is likewise omitted: `principalId` identifies the subject, and email in a hot
 * attribute record is PII the metadata-only policy does not need.
 */
export function toPeriodicUsageFacts(
  response: AmpDailyUsageResponse,
  artifact: RawArtifact,
  context: AdapterContext,
): PeriodicUsageFactInput[] {
  const facts: PeriodicUsageFactInput[] = [];

  for (const day of response.data) {
    const periodStart = `${day.date}T00:00:00.000Z`;
    const periodEnd = new Date(Date.parse(periodStart) + 86_400_000).toISOString();

    for (const entry of day.users) {
      const models = Object.entries(entry.models);
      if (models.length === 0) continue;

      for (const [modelName, metrics] of models) {
        const fact: PeriodicUsageFactInput = {
          sourceFactId: `amp:daily:${day.date}:${entry.user.id}:${modelName}`,
          tenantId: context.tenantId,
          source: { kind: SOURCE_KIND, provider: SOURCE_PROVIDER },
          grain: "principal_day_model",
          period: { start: periodStart, end: periodEnd },
          // Fetch time: the rollup carries no per-record as-of stamp of its own.
          asOf: artifact.fetchedAt,
          principalId: entry.user.id,
          model: {
            // The daily rollup keys by model name only and does not break out the upstream
            // provider, unlike `/threads/{id}/usage` which reports `provider` explicitly.
            provider: SOURCE_PROVIDER,
            name: modelName,
          },
          usage: {
            requests: metrics.requests,
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            cacheReadTokens: metrics.cacheReadInputTokens,
            cacheWriteTokens: metrics.cacheCreationInputTokens,
            providerReportedCost: { amount: toDecimalString(metrics.usage), currency: "USD" },
          },
          capture: {
            policyVersion: context.policyVersion,
            redaction: context.redaction ?? "not_applicable",
          },
          vendor: {
            namespace: VENDOR_NAMESPACE,
            attributes: {
              // Amp reports a totalTokens the contract has no field for; keep it rather than drop it.
              // Strictly per-model, so it carries no false attribution.
              totalTokens: metrics.totalTokens,
            },
            rawPayload: rawPayloadRef(artifact),
          },
        };
        facts.push(fact);
      }
    }
  }

  return facts;
}

/**
 * Maps per-thread cost onto run-linked telemetry events.
 *
 * One event per provider/model bucket rather than one per thread. The thread total is the sum of
 * its buckets, so emitting a separate total event as well would double-count spend.
 *
 * Trace mapping follows `docs/EVENT_CONTRACT.md`: `runId` and `traceId` are the thread, while
 * `spanId` is the per-observation `sourceEventId` so one thread's buckets stay distinguishable.
 * `sourceEventId` is stable across restatements — a re-poll of a still-active thread describes
 * the same logical fact, and the changed value produces a new `revisionDigest`.
 *
 * Sub-thread cost is already rolled into the parent by the API. `subThreadIDs` is recorded in
 * vendor attributes so downstream readers can verify no sub-thread was ingested separately.
 */
export function toThreadUsageEvents(
  usage: AmpThreadUsage,
  thread: AmpThreadSummary | undefined,
  artifact: RawArtifact,
  context: AdapterContext,
): RawTelemetryEvent[] {
  const observedAt = thread?.updatedAt ?? thread?.createdAt ?? artifact.fetchedAt;

  return usage.models.map((bucket) => {
    const sourceEventId = `amp:thread-usage:${usage.threadID}:${bucket.provider}:${bucket.model}`;
    return {
      sourceEventId,
      tenantId: context.tenantId,
      source: { kind: SOURCE_KIND, provider: SOURCE_PROVIDER },
      identity: {
        principalId: thread?.creatorUserID ?? "unknown",
        actorType: thread?.creatorUserID ? ("human" as const) : ("unknown" as const),
      },
      trace: {
        runId: usage.threadID,
        traceId: usage.threadID,
        spanId: sourceEventId,
      },
      observedAt,
      receivedAt: artifact.fetchedAt,
      operation: "model_call" as const,
      status: "succeeded" as const,
      capture: {
        mode: "metadata_only" as const,
        contentIncluded: false,
        redaction: context.redaction ?? ("not_applicable" as const),
        policyVersion: context.policyVersion,
        payloadDigest: toDigest(artifact.contentHash),
      },
      usage: {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheReadTokens: bucket.cacheReadInputTokens,
        cacheWriteTokens: bucket.cacheCreationInputTokens,
        providerReportedCost: { amount: toDecimalString(bucket.usage), currency: "USD" },
      },
      model: { provider: bucket.provider, name: bucket.model },
      attributes: {
        requests: bucket.requests,
        threadId: usage.threadID,
      },
      vendor: {
        namespace: VENDOR_NAMESPACE,
        attributes: {
          subThreadIds: usage.subThreadIDs,
          threadTotalUsageUsd: toDecimalString(usage.usage),
          ...(thread?.mainThreadID === undefined ? {} : { mainThreadId: thread.mainThreadID }),
          ...(Array.isArray(thread?.repositories)
            ? { repositories: thread.repositories.filter((r): r is string => typeof r === "string") }
            : {}),
        },
        rawPayload: rawPayloadRef(artifact),
      },
    };
  });
}
