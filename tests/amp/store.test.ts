import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCheckpointStore, FileRawStore, InvalidArtifactError } from "../../src/amp/store.js";
import type { RawArtifact } from "../../src/amp/types.js";

function artifact(overrides: Partial<RawArtifact> = {}): RawArtifact {
  return {
    key: "thread-usage/T-1",
    endpoint: "/api/v2/threads/T-1/usage",
    params: {},
    httpStatus: 200,
    fetchedAt: "2026-08-12T00:00:00.000Z",
    contentHash: createHash("sha256").update('{"usage":1}', "utf8").digest("hex"),
    body: { usage: 1 },
    bodyText: '{"usage":1}',
    redactedFields: [],
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
    const bodyText = '{"shard":true}';
    const contentHash = createHash("sha256").update(bodyText, "utf8").digest("hex");

    const result = await store.put(artifact({ bodyText, contentHash, body: { shard: true } }));

    expect(result.path).toBe(join("blobs", contentHash.slice(0, 2), `${contentHash}.json`));
  });

  it("rejects a non-canonical contentHash before it is used as a path", async () => {
    // Regression (review finding from Codex on PR #2): contentHash becomes a path segment, and
    // "../..".slice(0,2) is "..", so an unvalidated hash escapes the archive root.
    //
    // Exercised through has(), which does no integrity check — otherwise the hash/bytes
    // comparison would reject these inputs first and this would pass without the path guard
    // ever running.
    const store = new FileRawStore(await mkdtemp(join(tmpdir(), "store-")));

    for (const bad of ["../../../../tmp/pwned", "A".repeat(64), "short", `${"a".repeat(63)}/x`]) {
      await expect(store.has(bad)).rejects.toBeInstanceOf(InvalidArtifactError);
    }
    await expect(store.has("a".repeat(64))).resolves.toBe(false);
  });

  it("rejects an artifact whose hash does not describe its bytes", async () => {
    // The hash is the integrity receipt consumers verify against; a mislabelled blob would
    // otherwise pass verification later and misrepresent what was archived.
    const store = new FileRawStore(await mkdtemp(join(tmpdir(), "store-")));

    await expect(
      store.put(artifact({ bodyText: '{"tampered":true}', contentHash: "b".repeat(64) })),
    ).rejects.toBeInstanceOf(InvalidArtifactError);
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

  it("stores exactly the bytes that were hashed so the digest identifies the blob", async () => {
    // Regression (review finding from Codex on PR #2): the store previously wrote
    // JSON.stringify(body, null, 2), so rawPayload.digest never matched the referenced blob.
    const { createHash } = await import("node:crypto");
    const root = await mkdtemp(join(tmpdir(), "store-"));
    const store = new FileRawStore(root);
    const bodyText = '{"usage":1.5,"threadID":"T-1"}';
    const contentHash = createHash("sha256").update(bodyText).digest("hex");

    const result = await store.put(
      artifact({ bodyText, contentHash, body: JSON.parse(bodyText) as unknown }),
    );

    const onDisk = await readFile(join(root, result.path), "utf8");
    expect(onDisk).toBe(bodyText);
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(contentHash);
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
