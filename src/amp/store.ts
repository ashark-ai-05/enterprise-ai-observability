import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RawArtifact } from "./types.js";

export interface PutResult {
  /** False when an identical body was already stored (same contentHash). */
  stored: boolean;
  /** Location of the body, relative to the archive root. */
  path: string;
}

/**
 * Raw artifact storage.
 *
 * Deliberately minimal so an object-storage implementation can replace the filesystem one
 * without touching the archiver. Bodies are content-addressed; the observation log is
 * append-only and records every fetch, including ones whose body deduped.
 */
export interface RawStore {
  put(artifact: RawArtifact): Promise<PutResult>;
  has(contentHash: string): Promise<boolean>;
  /** Append a line to the observation log. Used for both successes and non-retryable misses. */
  observe(record: Record<string, unknown>): Promise<void>;
}

/**
 * Filesystem archive.
 *
 * Layout:
 *   <root>/blobs/<hh>/<contentHash>.json   body, written once, immutable
 *   <root>/observations.jsonl              append-only log of every fetch outcome
 *
 * Splitting bodies from the log matters: an active thread re-polled ten times stores one body
 * per distinct cost snapshot but ten observations, so "when did we learn this" stays answerable.
 */
export class FileRawStore implements RawStore {
  constructor(private readonly root: string) {}

  private blobPath(contentHash: string): string {
    return join("blobs", contentHash.slice(0, 2), `${contentHash}.json`);
  }

  async has(contentHash: string): Promise<boolean> {
    return existsSync(join(this.root, this.blobPath(contentHash)));
  }

  async put(artifact: RawArtifact): Promise<PutResult> {
    const relative = this.blobPath(artifact.contentHash);
    const absolute = join(this.root, relative);
    if (existsSync(absolute)) {
      return { stored: false, path: relative };
    }
    await mkdir(dirname(absolute), { recursive: true });
    // Bodies are immutable once written, so pretty-printing costs nothing at read time
    // and makes the archive greppable during incident review.
    await writeFile(absolute, JSON.stringify(artifact.body, null, 2), "utf8");
    return { stored: true, path: relative };
  }

  async observe(record: Record<string, unknown>): Promise<void> {
    const absolute = join(this.root, "observations.jsonl");
    await mkdir(dirname(absolute), { recursive: true });
    await appendFile(absolute, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export interface CheckpointState {
  /**
   * Highest `firstSyncedAt` seen. Used as the `after` filter for discovering new threads.
   * Not sufficient on its own to catch activity on older threads — see ThreadArchiver.
   */
  lastFirstSyncedAt?: string;
  /** Thread IDs whose usage is captured and final (thread inactive, or past the cliff). */
  settledThreadIds?: string[];
  /** Thread IDs confirmed past the 90-day usage window; never re-request these. */
  expiredThreadIds?: string[];
  /** ISO timestamp of the last completed run. */
  lastRunAt?: string;
  /** Earliest date already covered by a daily-usage backfill. */
  dailyUsageBackfilledFrom?: string;
}

/** Durable cursor state. JSON on disk now; a row in Postgres once the shared schema lands. */
export class FileCheckpointStore {
  constructor(private readonly path: string) {}

  async read(): Promise<CheckpointState> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as CheckpointState;
    } catch {
      // A truncated checkpoint must not wedge the archiver: a full re-walk is slow but correct,
      // and every write is idempotent, so starting over is always safe.
      return {};
    }
  }

  async write(state: CheckpointState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a half-parsed checkpoint.
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temporary, this.path);
  }
}
