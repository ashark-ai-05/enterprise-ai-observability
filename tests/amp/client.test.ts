import { describe, expect, it } from "vitest";
import { AmpClient, AmpNotAvailableError, AmpRequestError } from "../../src/amp/client.js";

interface StubResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Minimal fetch stub: returns queued responses in order and records the URLs requested. */
function stubFetch(responses: StubResponse[]): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL) => {
    urls.push(String(input));
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!response) throw new Error("no stub response queued");
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: { get: (name: string) => response.headers?.[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(response.body),
    };
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls };
}

function client(responses: StubResponse[], overrides: Record<string, unknown> = {}) {
  const stub = stubFetch(responses);
  return {
    urls: stub.urls,
    client: new AmpClient({
      apiKey: "test-key",
      fetch: stub.fetch,
      sleep: async () => {},
      backoffBaseMs: 1,
      ...overrides,
    }),
  };
}

describe("AmpClient", () => {
  it("returns parsed data alongside a content-hashed raw artifact", async () => {
    const body = { threadID: "T-1", subThreadIDs: [], usage: 1.25, models: [] };
    const { client: amp } = client([{ status: 200, body }]);

    const result = await amp.getThreadUsage("T-1");

    expect(result.data.usage).toBe(1.25);
    expect(result.artifact.body).toEqual(body);
    expect(result.artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifact.key).toBe("thread-usage/T-1");
    expect(result.artifact.httpStatus).toBe(200);
  });

  it("retries retryable statuses and succeeds", async () => {
    const { client: amp, urls } = client([
      { status: 503, body: { error: "unavailable" } },
      { status: 200, body: { threadID: "T-2", subThreadIDs: [], usage: 0, models: [] } },
    ]);

    const result = await amp.getThreadUsage("T-2");

    expect(result.data.threadID).toBe("T-2");
    expect(urls).toHaveLength(2);
  });

  it("honours Retry-After on 429 instead of its own backoff", async () => {
    const delays: number[] = [];
    const stub = stubFetch([
      { status: 429, body: { error: "slow down" }, headers: { "retry-after": "7" } },
      { status: 200, body: { threadID: "T-3", subThreadIDs: [], usage: 0, models: [] } },
    ]);
    const amp = new AmpClient({
      apiKey: "k",
      fetch: stub.fetch,
      backoffBaseMs: 1,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await amp.getThreadUsage("T-3");

    expect(delays).toEqual([7000]);
  });

  it("raises AmpNotAvailableError on 404 without retrying", async () => {
    // 404 on thread usage means the record aged past the 90-day window. Retrying is pointless.
    const { client: amp, urls } = client([
      { status: 404, body: { error: "usage data not available" } },
    ]);

    await expect(amp.getThreadUsage("T-old")).rejects.toBeInstanceOf(AmpNotAvailableError);
    expect(urls).toHaveLength(1);
  });

  it("raises AmpRequestError on a non-retryable 4xx without retrying", async () => {
    const { client: amp, urls } = client([{ status: 403, body: { error: "missing scope" } }]);

    await expect(amp.getThreadUsage("T-4")).rejects.toBeInstanceOf(AmpRequestError);
    expect(urls).toHaveLength(1);
  });

  it("gives up after maxAttempts on persistent retryable failures", async () => {
    const { client: amp, urls } = client([{ status: 500, body: { error: "boom" } }], {
      maxAttempts: 3,
    });

    await expect(amp.getThreadUsage("T-5")).rejects.toThrow(/exhausted 3 attempts/);
    expect(urls).toHaveLength(3);
  });

  it("walks every page of threads and stops at the final cursor", async () => {
    const { client: amp } = client([
      { status: 200, body: { threads: [{ id: "T-1", creatorUserID: "u1" }], nextCursor: "c2" } },
      { status: 200, body: { threads: [{ id: "T-2", creatorUserID: "u1" }] } },
    ]);

    const ids: string[] = [];
    for await (const { thread } of amp.iterateThreads({})) ids.push(thread.id);

    expect(ids).toEqual(["T-1", "T-2"]);
  });

  it("terminates instead of looping when the server repeats a cursor", async () => {
    // A server echoing the same cursor forever would otherwise hang the archiver.
    const { client: amp } = client([
      { status: 200, body: { threads: [{ id: "T-1", creatorUserID: "u1" }], nextCursor: "stuck" } },
    ]);

    const ids: string[] = [];
    for await (const { thread } of amp.iterateThreads({})) ids.push(thread.id);

    expect(ids).toEqual(["T-1", "T-1"]);
  });

  it("clamps lookbackDays to the documented 365-day maximum", async () => {
    const { client: amp, urls } = client([
      {
        status: 200,
        body: {
          metadata: { startDate: "a", endDate: "b", activeUsers: 0, totalUsers: 0, totalUsage: 0 },
          data: [],
        },
      },
    ]);

    await amp.getDailyUsage({ lookbackDays: 9999 });

    expect(urls[0]).toContain("lookbackDays=365");
  });

  it("clamps page size to the documented 100-row maximum", () => {
    const { client: amp } = client([], { pageSize: 500 });
    expect(amp.pageSize).toBe(100);
  });
});

describe("AmpClient response limits", () => {
  function streamingFetch(body: string, declaredLength?: string): typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? (declaredLength ?? null) : null) },
      body: {
        getReader() {
          const chunks = [new TextEncoder().encode(body)];
          let i = 0;
          return {
            read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
      text: async () => body,
    })) as unknown as typeof fetch;
  }

  it("rejects a response whose declared Content-Length exceeds the cap", async () => {
    const amp = new AmpClient({
      apiKey: "k",
      fetch: streamingFetch("{}", "999999999"),
      maxResponseBytes: 1024,
    });

    await expect(amp.getThreadUsage("T-1")).rejects.toThrow(/exceeded 1024 bytes/);
  });

  it("rejects an oversized chunked response that declared no length", async () => {
    // Chunked responses can omit or understate Content-Length, so the running total is enforced.
    const amp = new AmpClient({
      apiKey: "k",
      fetch: streamingFetch(JSON.stringify({ padding: "x".repeat(5000) })),
      maxResponseBytes: 1024,
    });

    await expect(amp.getThreadUsage("T-1")).rejects.toThrow(/exceeded 1024 bytes/);
  });

  it("accepts a response inside the cap", async () => {
    const amp = new AmpClient({
      apiKey: "k",
      fetch: streamingFetch(JSON.stringify({ threadID: "T-1", subThreadIDs: [], usage: 1, models: [] })),
      maxResponseBytes: 1024,
    });

    await expect(amp.getThreadUsage("T-1")).resolves.toMatchObject({ data: { threadID: "T-1" } });
  });

  it("validates the cap itself rather than accepting a nonsensical limit", () => {
    expect(() => new AmpClient({ apiKey: "k", maxResponseBytes: 0 })).toThrow(RangeError);
    expect(() => new AmpClient({ apiKey: "k", maxResponseBytes: -1 })).toThrow(RangeError);
  });
});
