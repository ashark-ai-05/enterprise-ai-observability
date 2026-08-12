/**
 * Types transcribed from Amp's published OpenAPI schema (https://ampcode.com/api/v2/openapi.json),
 * read 2026-08-12. Field names and optionality mirror the schema exactly — do not "tidy" them,
 * because the raw archive is keyed on these shapes and normalization happens downstream.
 *
 * Two retention windows matter here and they are NOT the same:
 *   - thread usage      (`/threads/{id}/usage`)            : 90 days, per the endpoint description
 *   - workspace rollups (`/workspace/analytics/daily-usage`): 365 days, per `lookbackDays` max
 */

/** Scopes the archiver may need. Missing scopes degrade the archive rather than failing it. */
export const AMP_SCOPES = {
  threadsMeta: "amp.api:workspace.threads.meta:view",
  threadsContents: "amp.api:workspace.threads.contents:view",
  analytics: "amp.api:workspace.analytics:view",
  members: "amp.api:workspace.members:view",
} as const;

/** `GET /api/v2/threads` — item. Only `id` and `creatorUserID` are guaranteed. */
export interface AmpThreadSummary {
  id: string;
  creatorUserID: string;
  /** Requires `threads.contents:view`. */
  title?: string;
  createdAt?: string;
  /** Last activity. NOT what `after`/`before` filter on — see `firstSyncedAt`. */
  updatedAt?: string;
  /**
   * What the list endpoint's `after`/`before` parameters actually filter on.
   * A thread first synced months ago but active today will NOT match `after=<recent>`.
   */
  firstSyncedAt?: string;
  /** Set when this is a sub-thread. */
  mainThreadID?: string;
  /** Requires `threads.contents:view`. Vendor-reported repo attribution. */
  repositories?: unknown[];
  subThreads?: unknown[];
}

export interface AmpThreadListResponse {
  threads: AmpThreadSummary[];
  /** Absent or empty when the page is the last one. */
  nextCursor?: string;
}

/** `GET /api/v2/threads/{threadID}/usage` — per provider/model breakdown. */
export interface AmpThreadModelUsage {
  provider: string;
  model: string;
  requests: number;
  /** Uncached input tokens only; cache tokens are reported separately. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** USD. */
  usage: number;
}

export interface AmpThreadUsage {
  threadID: string;
  /** Sub-threads rolled into this thread's cost — do not double-count them. */
  subThreadIDs: string[];
  /** Total USD for the thread including its sub-threads. */
  usage: number;
  models: AmpThreadModelUsage[];
}

/** `GET /api/v2/workspace/analytics/daily-usage` — the 365-day rollup. */
export interface AmpDailyUsageModelMetrics {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  /** USD. */
  usage: number;
}

export interface AmpDailyUsageUserEntry {
  user: {
    id: string;
    /** Requires `members:view`. */
    email?: string;
  };
  metrics: {
    /** Vendor-reported code volume. Volume is not value — see docs/ARCHITECTURE.md §3.3. */
    linesAdded: number;
    linesDeleted: number;
    linesModified: number;
    /** USD attributed to this user on this day. */
    usage: number;
  };
  /** Keyed by model identifier. */
  models: Record<string, AmpDailyUsageModelMetrics>;
}

export interface AmpDailyUsageResponse {
  metadata: {
    startDate: string;
    endDate: string;
    activeUsers: number;
    /** Includes former members with workspace-attributed usage. */
    totalUsers: number;
    /** USD across the period. */
    totalUsage: number;
  };
  data: Array<{ date: string; users: AmpDailyUsageUserEntry[] }>;
}

export interface AmpErrorResponse {
  error: string;
}

/**
 * Envelope wrapping every archived response.
 *
 * The archive stores raw vendor JSON verbatim. Normalization to the shared event contract
 * happens downstream and may be re-run; that is only safe if nothing is discarded on ingest.
 */
export interface RawArtifact {
  /** Stable logical identity, e.g. `thread-usage/T-abc123` or `daily-usage/2026-08-12`. */
  key: string;
  /** Endpoint path, without the base URL. */
  endpoint: string;
  /** Query parameters as sent. */
  params: Record<string, string>;
  httpStatus: number;
  /** When the archiver received the response. */
  fetchedAt: string;
  /** sha256 of the canonical body bytes; identical bodies dedupe to one stored object. */
  contentHash: string;
  /** Exactly as returned by the API. Never transformed. */
  body: unknown;
}
