import { createHash } from "node:crypto";
import type {
  AmpDailyUsageResponse,
  AmpThreadListResponse,
  AmpThreadSummary,
  AmpThreadUsage,
  RawArtifact,
} from "./types.js";

type Fetch = typeof fetch;

export interface AmpClientOptions {
  /** Defaults to `https://ampcode.com`. */
  baseUrl?: string;
  /** Workspace API key (`AMP_API_KEY`). */
  apiKey: string;
  fetch?: Fetch;
  /** Attempts per request, including the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms, doubled per attempt with jitter. Default 500. */
  backoffBaseMs?: number;
  /** Injectable for tests; defaults to real sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Page size for thread listing, 1–100. Default 100. */
  pageSize?: number;
}

/** A response the caller asked for that the API says does not exist. Not an error condition. */
export class AmpNotAvailableError extends Error {
  constructor(
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(`Amp resource not available: ${endpoint} (${detail})`);
    this.name = "AmpNotAvailableError";
  }
}

/** Non-retryable API failure (4xx other than 404/429). */
export class AmpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(`Amp request failed ${status}: ${endpoint} (${detail})`);
    this.name = "AmpRequestError";
  }
}

export interface Fetched<T> {
  data: T;
  artifact: RawArtifact;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function hashBody(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class AmpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: Fetch;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly pageSize: number;

  constructor(options: AmpClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://ampcode.com").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
  }

  /**
   * Retry policy: 429 and 5xx back off and retry, honouring `Retry-After` when present.
   * 404 raises AmpNotAvailableError immediately — for thread usage that means the record has
   * aged past the 90-day window, which is a fact to record rather than a failure to retry.
   */
  private async request<T>(
    endpoint: string,
    params: Record<string, string>,
    key: string,
  ): Promise<Fetched<T>> {
    const url = new URL(this.baseUrl + endpoint);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let lastRetryable = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const response = await this.doFetch(url.toString(), {
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
        },
      });
      const text = await response.text();

      if (response.ok) {
        return {
          data: JSON.parse(text) as T,
          artifact: {
            key,
            endpoint,
            params,
            httpStatus: response.status,
            fetchedAt: new Date().toISOString(),
            contentHash: hashBody(text),
            body: JSON.parse(text),
          },
        };
      }

      if (response.status === 404) {
        throw new AmpNotAvailableError(endpoint, extractError(text));
      }

      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new AmpRequestError(response.status, endpoint, extractError(text));
      }

      lastRetryable = `${response.status} ${extractError(text)}`;
      if (attempt < this.maxAttempts) {
        await this.sleep(this.backoffDelay(attempt, response.headers.get("retry-after")));
      }
    }

    throw new AmpRequestError(
      429,
      endpoint,
      `exhausted ${this.maxAttempts} attempts: ${lastRetryable}`,
    );
  }

  /** Exponential backoff with full jitter; `Retry-After` (seconds) wins when the server sends it. */
  private backoffDelay(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
    const ceiling = this.backoffBaseMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * ceiling);
  }

  /**
   * One page of threads.
   *
   * `after`/`before` filter on the thread's *initial sync time*, not last update, so they are
   * a discovery cursor only. Detecting activity on already-known threads needs `updatedAt`
   * from the returned rows — see ThreadArchiver.
   */
  async listThreads(options: {
    cursor?: string;
    after?: string;
    before?: string;
    sort?: "ASC" | "DESC";
  }): Promise<Fetched<AmpThreadListResponse>> {
    const params: Record<string, string> = { limit: String(this.pageSize) };
    if (options.cursor) params.cursor = options.cursor;
    if (options.after) params.after = options.after;
    if (options.before) params.before = options.before;
    if (options.sort) params.sort = options.sort;
    const cursorKey = options.cursor ? options.cursor.slice(0, 16) : "start";
    return this.request<AmpThreadListResponse>(
      "/api/v2/threads",
      params,
      `threads/page-${cursorKey}`,
    );
  }

  /** Walks every page. Yields rows as they arrive so a long backfill can persist incrementally. */
  async *iterateThreads(options: {
    after?: string;
    before?: string;
    sort?: "ASC" | "DESC";
  }): AsyncGenerator<{ thread: AmpThreadSummary; artifact: RawArtifact }> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const opts: Parameters<typeof this.listThreads>[0] = { ...options };
      if (cursor) opts.cursor = cursor;
      const page = await this.listThreads(opts);
      for (const thread of page.data.threads) {
        yield { thread, artifact: page.artifact };
      }
      const next = page.data.nextCursor;
      if (!next || next === cursor) return;
      // A server that returns a repeating cursor would otherwise loop forever.
      if (seenCursors.has(next)) return;
      seenCursors.add(next);
      cursor = next;
    }
  }

  /** Per-thread cost. Throws AmpNotAvailableError once the thread passes the 90-day window. */
  async getThreadUsage(threadId: string): Promise<Fetched<AmpThreadUsage>> {
    return this.request<AmpThreadUsage>(
      `/api/v2/threads/${encodeURIComponent(threadId)}/usage`,
      {},
      `thread-usage/${threadId}`,
    );
  }

  /**
   * Workspace rollup. `lookbackDays` is capped at 365 by the API, which is why aggregate
   * history survives far longer than per-thread cost.
   */
  async getDailyUsage(options: { endDate?: string; lookbackDays?: number }): Promise<
    Fetched<AmpDailyUsageResponse>
  > {
    const params: Record<string, string> = {};
    if (options.endDate) params.endDate = options.endDate;
    if (options.lookbackDays !== undefined) {
      params.lookbackDays = String(Math.min(Math.max(options.lookbackDays, 1), 365));
    }
    const keySuffix = options.endDate ?? "today";
    return this.request<AmpDailyUsageResponse>(
      "/api/v2/workspace/analytics/daily-usage",
      params,
      `daily-usage/${keySuffix}`,
    );
  }
}

function extractError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Body was not the documented error envelope; fall through to the raw text.
  }
  return text.slice(0, 200);
}
