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
    // Exactly the bytes that were hashed. Re-serializing (e.g. pretty-printing) would make
    // rawPayload.digest fail to verify against the blob it points at.
    // wx: exclusive create, so a concurrent writer cannot half-overwrite an immutable blob.
    try {
      await writeFile(absolute, artifact.bodyText, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { stored: false, path: relative };
      throw error;
    }
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
   * Highest `firstSyncedAt` seen, for reporting only.
   *
   * Deliberately NOT used as a request cursor: `after` filters on initial sync time, so
   * advancing it would hide already-known active threads and freeze their cost. The archiver
   * anchors `after` to the 90-day cliff boundary instead.
   */
  lastFirstSyncedAt?: string;
  /** When the one-time unbounded sweep ran. Until set, listing is unfiltered. */
  coldStartSweepAt?: string;
  /**
   * Threads whose usage was captured while quiet, keyed by the `updatedAt` observed at
   * settlement. Storing the version rather than a bare ID is what lets a *resumed* thread be
   * re-fetched: if current `updatedAt` is newer than the settled one, settlement is void.
   */
  settledThreads?: Record<string, string>;
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
