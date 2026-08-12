import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalEventSchema } from "../../src/contracts/events.js";
import {
  type GatewayDeps,
  handleGatewayRequest,
} from "../../src/gateway/gateway.js";
import { StaticPrincipalRegistry } from "../../src/gateway/principals.js";
import type { ProviderRoute } from "../../src/gateway/routes.js";
import { InMemoryEventSink } from "../../src/gateway/sink.js";

/**
 * `handleGatewayRequest` now runs every emitted event through the real
 * `normalizeTelemetryEvent()` (PR #1), which itself calls
 * `canonicalEventSchema.parse()` internally — so a schema violation like the
 * original model_call-without-model bug would already throw inside
 * `handleGatewayRequest` and fail every test in this suite, not just this
 * one. This file exists to make that guarantee explicit and named per
 * scenario, rather than relying on an incidental throw elsewhere to catch a
 * regression.
 */
describe("emitted events conform to the real canonical event schema (PR #1)", () => {
  let server: Server;
  let route: ProviderRoute;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "gpt-x",
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    route = {
      provider: "internal-maas",
      baseUrl: `http://127.0.0.1:${port}`,
      upstreamAuthHeader: "x-upstream-key",
      upstreamApiKey: "secret",
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function buildDeps(sink: InMemoryEventSink): GatewayDeps {
    return {
      routes: [route],
      priceBook: {
        version: "v1",
        effectiveFrom: new Date(0).toISOString(),
        entries: [],
      },
      sink,
      principals: new StaticPrincipalRegistry(
        new Map([
          [
            "good-key",
            {
              principalId: "svc-1",
              tenant: "acme",
              team: undefined,
              actorType: "service" as const,
            },
          ],
        ]),
      ),
    };
  }

  it("both the started receipt and the terminal restatement round-trip through the real schema", async () => {
    const sink = new InMemoryEventSink();
    await handleGatewayRequest(buildDeps(sink), {
      provider: "internal-maas",
      path: "/v1/chat",
      method: "POST",
      headers: { authorization: "Bearer good-key" },
      body: JSON.stringify({ model: "gpt-x" }),
    });
    expect(sink.events).toHaveLength(2);
    for (const event of sink.events) {
      expect(event.operation).toBe("model_call");
      expect(canonicalEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("an auth-failure policy event round-trips (this is exactly the shape the earlier bug broke)", async () => {
    const sink = new InMemoryEventSink();
    await handleGatewayRequest(buildDeps(sink), {
      provider: "internal-maas",
      path: "/v1/chat",
      method: "POST",
      headers: {},
    });
    expect(sink.events[0]!.operation).toBe("policy");
    expect(canonicalEventSchema.safeParse(sink.events[0]).success).toBe(true);
  });

  it("an unknown-provider policy event round-trips", async () => {
    const sink = new InMemoryEventSink();
    await handleGatewayRequest(buildDeps(sink), {
      provider: "does-not-exist",
      path: "/v1/chat",
      method: "POST",
      headers: { authorization: "Bearer good-key" },
    });
    expect(canonicalEventSchema.safeParse(sink.events[0]).success).toBe(true);
  });

  it("an SSRF-blocked policy event round-trips", async () => {
    const sink = new InMemoryEventSink();
    await handleGatewayRequest(buildDeps(sink), {
      provider: "internal-maas",
      path: "http://127.0.0.1:1/steal",
      method: "GET",
      headers: { authorization: "Bearer good-key" },
    });
    expect(canonicalEventSchema.safeParse(sink.events[0]).success).toBe(true);
  });
});
