import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AmpClient } from "../../src/amp/client.js";
import { redactResponse } from "../../src/amp/redact.js";
import { FileRawStore } from "../../src/amp/store.js";

function stub(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("redactResponse", () => {
  it("strips thread titles, which are free text and may carry customer or ticket detail", () => {
    const { body, removed } = redactResponse("/api/v2/threads", {
      threads: [
        { id: "T-1", creatorUserID: "u", title: "Fix ACME Corp billing bug PROJ-42" },
        { id: "T-2", creatorUserID: "u" },
      ],
    });

    expect(JSON.stringify(body)).not.toContain("ACME Corp");
    expect(removed).toEqual(["threads[].title"]);
  });

  it("strips user email from the daily rollup", () => {
    const { body, removed } = redactResponse("/api/v2/workspace/analytics/daily-usage", {
      data: [{ date: "2026-08-12", users: [{ user: { id: "u1", email: "dev@example.com" } }] }],
    });

    expect(JSON.stringify(body)).not.toContain("dev@example.com");
    expect(removed).toEqual(["data[].users[].user.email"]);
  });

  it("leaves repository names alone — they are metadata, not content", () => {
    const { body } = redactResponse("/api/v2/threads", {
      threads: [{ id: "T-1", creatorUserID: "u", repositories: ["acme/api"] }],
    });

    expect(JSON.stringify(body)).toContain("acme/api");
  });

  it("returns the body untouched when nothing matches", () => {
    const input = { threadID: "T-1", usage: 1 };
    const { body, removed } = redactResponse("/api/v2/threads/T-1/usage", input);

    expect(body).toBe(input);
    expect(removed).toEqual([]);
  });

  it("passes everything through when sensitive capture is explicitly allowed", () => {
    const { body, removed } = redactResponse(
      "/api/v2/threads",
      { threads: [{ id: "T-1", creatorUserID: "u", title: "secret" }] },
      true,
    );

    expect(JSON.stringify(body)).toContain("secret");
    expect(removed).toEqual([]);
  });
});

describe("archive persistence under the default capture policy", () => {
  it("never writes a title or email to the default filesystem archive", async () => {
    // The metadata-only policy (D3) must hold for the raw archive too; holding the
    // threads.contents:view scope must not silently reclassify what is stored.
    const client = new AmpClient({
      apiKey: "k",
      fetch: stub({
        threads: [{ id: "T-1", creatorUserID: "u1", title: "Migrate ACME payment secrets" }],
      }),
    });
    const root = await mkdtemp(join(tmpdir(), "redact-"));
    const store = new FileRawStore(root);

    const page = await client.listThreads({});
    const result = await store.put(page.artifact);
    const written = await readFile(join(root, result.path), "utf8");

    expect(written).not.toContain("ACME");
    expect(written).not.toContain("title");
    expect(page.artifact.redactedFields).toEqual(["threads[].title"]);
  });

  it("hashes post-redaction so the digest still identifies the stored bytes", async () => {
    const { createHash } = await import("node:crypto");
    const client = new AmpClient({
      apiKey: "k",
      fetch: stub({ threads: [{ id: "T-1", creatorUserID: "u1", title: "sensitive" }] }),
    });
    const root = await mkdtemp(join(tmpdir(), "redact-"));
    const store = new FileRawStore(root);

    const page = await client.listThreads({});
    const result = await store.put(page.artifact);
    const written = await readFile(join(root, result.path), "utf8");

    expect(createHash("sha256").update(written).digest("hex")).toBe(page.artifact.contentHash);
  });
});
