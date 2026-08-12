import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCheckpointStore, FileRawStore } from "../../src/amp/store.js";
import type { RawArtifact } from "../../src/amp/types.js";

function artifact(overrides: Partial<RawArtifact> = {}): RawArtifact {
  return {
    key: "thread-usage/T-1",
    endpoint: "/api/v2/threads/T-1/usage",
    params: {},
    httpStatus: 200,
    fetchedAt: "2026-08-12T00:00:00.000Z",
    contentHash: "a".repeat(64),
    body: { usage: 1 },
    ...overrides,
  };
}

describe("FileRawStore", () => {
  it("writes a body once and reports later identical bodies as deduped", async () => {
    const store = new FileRawStore(await mkdtemp(join(tmpdir(), "store-")));

    const first = await store.put(artifact());
    const second = await store.put(artifact());

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("shards blobs by hash prefix so one directory cannot grow unbounded", async () => {
    const store = new FileRawStore(await mkdtemp(join(tmpdir(), "store-")));

    const result = await store.put(artifact({ contentHash: `ab${"c".repeat(62)}` }));

    expect(result.path).toBe(join("blobs", "ab", `ab${"c".repeat(62)}.json`));
  });

  it("appends one JSON line per observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "store-"));
    const store = new FileRawStore(root);

    await store.observe({ stage: "thread-usage", outcome: "captured" });
    await store.observe({ stage: "thread-usage", outcome: "past-cliff" });

    const lines = (await readFile(join(root, "observations.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ outcome: "past-cliff" });
  });
});

describe("FileCheckpointStore", () => {
  it("round-trips state", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "ckpt-")), "checkpoint.json");
    const store = new FileCheckpointStore(path);

    await store.write({ lastFirstSyncedAt: "2026-08-01T00:00:00.000Z", expiredThreadIds: ["T-x"] });

    expect(await store.read()).toEqual({
      lastFirstSyncedAt: "2026-08-01T00:00:00.000Z",
      expiredThreadIds: ["T-x"],
    });
  });

  it("returns empty state for a missing file rather than throwing", async () => {
    const store = new FileCheckpointStore(
      join(await mkdtemp(join(tmpdir(), "ckpt-")), "absent.json"),
    );
    expect(await store.read()).toEqual({});
  });

  it("recovers from a corrupt checkpoint instead of wedging the archiver", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "ckpt-")), "checkpoint.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not json", "utf8");

    // A full re-walk is slow but correct; every write is idempotent so restarting is safe.
    expect(await new FileCheckpointStore(path).read()).toEqual({});
  });
});
