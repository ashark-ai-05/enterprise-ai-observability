import { type AmpClient, AmpNotAvailableError, AmpRequestError } from "./client.js";
import type { CheckpointState, FileCheckpointStore, RawStore } from "./store.js";
import type { AmpThreadSummary } from "./types.js";

/** Documented by Amp: thread usage is served only for threads under 90 days old. */
export const THREAD_USAGE_WINDOW_DAYS = 90;
/** Documented by Amp: `lookbackDays` on the daily-usage rollup is capped at 365. */
export const DAILY_USAGE_MAX_LOOKBACK_DAYS = 365;
/**
 * How often to re-run an unfiltered thread sweep.
 *
 * Bounded listing anchors `after` to the cliff boundary, which relies on every thread carrying
 * `firstSyncedAt`. The schema only guarantees `id` and `creatorUserID`, and how the live API
 * treats rows without a sync time under `after` is unverified. A periodic full sweep costs one
 * extra walk a week and caps the blast radius of that unknown at seven days.
 */
export const FULL_SWEEP_INTERVAL_DAYS = 7;

export interface ArchiveRunSummary {
  threadsSeen: number;
  usageFetched: number;
  usageExpired: number;
  usageSkippedSettled: number;
  usageSkippedSubThread: number;
  dailyUsageDaysArchived: number;
  bodiesStored: number;
  bodiesDeduped: number;
  errors: Array<{ threadId?: string; stage: string; message: string }>;
  /** Threads inside the window whose usage is still unfetched when the run ended. */
  atRiskThreadIds: string[];
}

/**
 * When to stop re-polling a thread's usage.
 *
 * A thread's cost is not final while the thread is active — poll once and you capture a partial
 * number that never updates. Poll every run forever and you burn API budget on settled threads.
 * The default treats "no activity for `settleAfterHours`" as final.
 */
export interface ThreadPollPolicy {
  /**
   * Hours of inactivity after which a thread's captured cost is treated as final.
   *
   * This is a real cost/completeness trade-off, not a tuning constant. Too low and threads
   * settle while still running, freezing a partial cost figure permanently. Too high and every
   * run re-polls hundreds of finished threads, spending rate-limit budget that the cliff-facing
   * backlog needs more. 24h is a conservative default; see docs/AMP_ARCHIVER.md.
   */
  settleAfterHours: number;
}

export const DEFAULT_POLL_POLICY: ThreadPollPolicy = {
  settleAfterHours: 24,
};

export interface ArchiverOptions {
  client: AmpClient;
  store: RawStore;
  checkpoints: FileCheckpointStore;
  policy?: ThreadPollPolicy;
  /** Injectable clock so cliff arithmetic is testable. */
  now?: () => Date;
  /** Days per daily-usage request during backfill. Default 30. */
  backfillChunkDays?: number;
}

export class AmpArchiver {
  private readonly client: AmpClient;
  private readonly store: RawStore;
  private readonly checkpoints: FileCheckpointStore;
  private readonly policy: ThreadPollPolicy;
  private readonly now: () => Date;
  private readonly backfillChunkDays: number;

  constructor(options: ArchiverOptions) {
    this.client = options.client;
    this.store = options.store;
    this.checkpoints = options.checkpoints;
    this.policy = options.policy ?? DEFAULT_POLL_POLICY;
    this.now = options.now ?? (() => new Date());
    this.backfillChunkDays = options.backfillChunkDays ?? 30;
  }

  async run(): Promise<ArchiveRunSummary> {
    const summary: ArchiveRunSummary = {
      threadsSeen: 0,
      usageFetched: 0,
      usageExpired: 0,
      usageSkippedSettled: 0,
      usageSkippedSubThread: 0,
      dailyUsageDaysArchived: 0,
      bodiesStored: 0,
      bodiesDeduped: 0,
      errors: [],
      atRiskThreadIds: [],
    };
    const state = await this.checkpoints.read();

    // Rollups first: they are one cheap call per chunk and they are what survives the
    // 90-day cliff, so a run that dies partway through threads still advanced the archive.
    await this.archiveDailyUsage(state, summary);
    await this.archiveThreads(state, summary);

    state.lastRunAt = this.now().toISOString();
    await this.checkpoints.write(state);
    return summary;
  }

  /**
   * Backfills the workspace rollup to the 365-day limit, then keeps the tail fresh.
   *
   * Recent days are re-fetched every run because the current day's usage is still accruing;
   * content-addressing means an unchanged day costs one dedupe rather than a new body.
   */
  private async archiveDailyUsage(
    state: CheckpointState,
    summary: ArchiveRunSummary,
  ): Promise<void> {
    const today = this.now();
    const earliestWanted = addDays(today, -DAILY_USAGE_MAX_LOOKBACK_DAYS);
    const backfilledFrom = state.dailyUsageBackfilledFrom
      ? new Date(state.dailyUsageBackfilledFrom)
      : today;

    // Walk backwards in chunks from wherever the backfill last reached.
    let cursor = backfilledFrom;
    while (cursor > earliestWanted) {
      const chunkEnd = cursor;
      const lookback = Math.min(
        this.backfillChunkDays,
        Math.max(1, daysBetween(earliestWanted, chunkEnd)),
      );
      const ok = await this.fetchDailyUsageChunk(toDateString(chunkEnd), lookback, summary);
      if (!ok) return; // Leave the checkpoint untouched so the next run retries this chunk.
      cursor = addDays(chunkEnd, -lookback);
      state.dailyUsageBackfilledFrom = toDateString(cursor);
    }

    // Always refresh the trailing window — today's figures are still moving.
    await this.fetchDailyUsageChunk(toDateString(today), this.backfillChunkDays, summary);
  }

  private async fetchDailyUsageChunk(
    endDate: string,
    lookbackDays: number,
    summary: ArchiveRunSummary,
  ): Promise<boolean> {
    try {
      const fetched = await this.client.getDailyUsage({ endDate, lookbackDays });
      const result = await this.store.put(fetched.artifact);
      this.countPut(result.stored, summary);
      summary.dailyUsageDaysArchived += fetched.data.data.length;
      await this.store.observe({
        stage: "daily-usage",
        endDate,
        lookbackDays,
        days: fetched.data.data.length,
        totalUsageUsd: fetched.data.metadata.totalUsage,
        activeUsers: fetched.data.metadata.activeUsers,
        contentHash: fetched.artifact.contentHash,
        deduped: !result.stored,
        fetchedAt: fetched.artifact.fetchedAt,
      });
      return true;
    } catch (error) {
      summary.errors.push({ stage: "daily-usage", message: describe(error) });
      await this.store.observe({
        stage: "daily-usage",
        endDate,
        lookbackDays,
        error: describe(error),
      });
      return false;
    }
  }

  /**
   * Discovers threads and captures per-thread cost before it expires.
   *
   * Ordering is deliberate: threads are processed oldest-first so the ones closest to the
   * 90-day cliff are captured first. If a run is interrupted or rate-limited, what survives
   * is the data that was about to become unrecoverable.
   */
  private async archiveThreads(state: CheckpointState, summary: ArchiveRunSummary): Promise<void> {
    const settled = new Set(state.settledThreadIds ?? []);
    const expired = new Set(state.expiredThreadIds ?? []);
    const now = this.now();

    const candidates: AmpThreadSummary[] = [];
    try {
      /**
       * The list cursor is the cliff boundary, NOT a high-water mark.
       *
       * `after` filters on `firstSyncedAt`, so advancing it to the newest thread seen would
       * hide every already-known thread on the next run — freezing an active thread's cost at
       * whatever the first run happened to capture. (Found in review by Codex; the original
       * test stub ignored `after` and so could not catch it.)
       *
       * Anchoring `after` to `now - 90d` instead returns exactly the threads whose usage is
       * still retrievable: bounded work, and known-but-active threads reappear every run.
       * There is no single-thread GET on this API, so re-listing is the only way to refresh
       * a thread's `updatedAt`.
       */
      const listOptions: Parameters<AmpClient["iterateThreads"]>[0] = { sort: "ASC" };
      const sweepDue = this.isFullSweepDue(state, now);
      if (!sweepDue) {
        listOptions.after = new Date(
          now.getTime() - THREAD_USAGE_WINDOW_DAYS * 86_400_000,
        ).toISOString();
      }

      for await (const { thread, artifact } of this.client.iterateThreads(listOptions)) {
        summary.threadsSeen += 1;
        const result = await this.store.put(artifact);
        this.countPut(result.stored, summary);
        candidates.push(thread);
        const synced = thread.firstSyncedAt;
        if (synced && (!state.lastFirstSyncedAt || synced > state.lastFirstSyncedAt)) {
          // Reporting high-water mark only — deliberately not used as a request cursor.
          state.lastFirstSyncedAt = synced;
        }
      }
      // Records when the last unfiltered sweep completed. The first one inventories threads
      // already past the cliff so the cold-start gap can be measured; later ones are the
      // safety net described on FULL_SWEEP_INTERVAL_DAYS.
      if (sweepDue) state.coldStartSweepAt = now.toISOString();
    } catch (error) {
      // Keep whatever was listed; a partial page still yields usable usage fetches.
      summary.errors.push({ stage: "list-threads", message: describe(error) });
    }

    const ordered = candidates
      .filter((thread) => !expired.has(thread.id))
      .sort((a, b) => threadAge(b, now) - threadAge(a, now));

    for (const thread of ordered) {
      // Sub-thread cost is already rolled into the parent's `usage`. Fetching both would
      // double-count spend, which is the worst possible bug in a cost system.
      if (thread.mainThreadID) {
        summary.usageSkippedSubThread += 1;
        continue;
      }

      if (this.isPastCliff(thread, now)) {
        expired.add(thread.id);
        summary.usageExpired += 1;
        await this.store.observe({
          stage: "thread-usage",
          threadId: thread.id,
          outcome: "past-cliff",
          ageDays: Math.floor(threadAge(thread, now) / 86_400_000),
        });
        continue;
      }

      // A thread enters `settled` only after its usage was captured *and* it had gone quiet,
      // so membership already implies "captured and final" — no second condition needed.
      if (settled.has(thread.id)) {
        summary.usageSkippedSettled += 1;
        continue;
      }

      try {
        const fetched = await this.client.getThreadUsage(thread.id);
        const result = await this.store.put(fetched.artifact);
        this.countPut(result.stored, summary);
        summary.usageFetched += 1;
        await this.store.observe({
          stage: "thread-usage",
          threadId: thread.id,
          outcome: "captured",
          usageUsd: fetched.data.usage,
          subThreadIds: fetched.data.subThreadIDs,
          models: fetched.data.models.map((m) => `${m.provider}/${m.model}`),
          contentHash: fetched.artifact.contentHash,
          deduped: !result.stored,
          fetchedAt: fetched.artifact.fetchedAt,
        });
        if (this.isSettled(thread, now)) settled.add(thread.id);
      } catch (error) {
        if (error instanceof AmpNotAvailableError) {
          // 404 here means the record is gone, not that the request was wrong. Record and move on.
          expired.add(thread.id);
          summary.usageExpired += 1;
          await this.store.observe({
            stage: "thread-usage",
            threadId: thread.id,
            outcome: "not-available",
            detail: error.detail,
          });
          continue;
        }
        summary.errors.push({
          threadId: thread.id,
          stage: "thread-usage",
          message: describe(error),
        });
        summary.atRiskThreadIds.push(thread.id);
        await this.store.observe({
          stage: "thread-usage",
          threadId: thread.id,
          outcome: "error",
          error: describe(error),
          retryable: !(error instanceof AmpRequestError),
        });
      }
    }

    state.settledThreadIds = [...settled];
    state.expiredThreadIds = [...expired];
  }

  /** True on the very first run, and once per FULL_SWEEP_INTERVAL_DAYS thereafter. */
  private isFullSweepDue(state: CheckpointState, now: Date): boolean {
    if (!state.coldStartSweepAt) return true;
    const last = new Date(state.coldStartSweepAt).getTime();
    if (Number.isNaN(last)) return true;
    return now.getTime() - last >= FULL_SWEEP_INTERVAL_DAYS * 86_400_000;
  }

  /** Cost stops changing once a thread goes quiet; until then any captured total is partial. */
  private isSettled(thread: AmpThreadSummary, now: Date): boolean {
    const updated = thread.updatedAt ? new Date(thread.updatedAt).getTime() : undefined;
    if (updated === undefined || Number.isNaN(updated)) return false;
    return now.getTime() - updated >= this.policy.settleAfterHours * 3_600_000;
  }

  private isPastCliff(thread: AmpThreadSummary, now: Date): boolean {
    const age = threadAge(thread, now);
    return age > THREAD_USAGE_WINDOW_DAYS * 86_400_000;
  }

  private countPut(stored: boolean, summary: ArchiveRunSummary): void {
    if (stored) summary.bodiesStored += 1;
    else summary.bodiesDeduped += 1;
  }
}

/**
 * Age in ms. Prefers `createdAt`; falls back to `firstSyncedAt`.
 * An unknown age is treated as 0 (young) so a missing timestamp never causes a thread
 * to be silently written off as expired without asking the API.
 */
function threadAge(thread: AmpThreadSummary, now: Date): number {
  const stamp = thread.createdAt ?? thread.firstSyncedAt;
  if (!stamp) return 0;
  const parsed = new Date(stamp).getTime();
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, now.getTime() - parsed);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
