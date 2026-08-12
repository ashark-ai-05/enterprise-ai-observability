import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventSink } from "../../src/gateway/sink.js";
import {
  type GatewayDeps,
  handleGatewayRequest,
} from "../../src/gateway/gateway.js";
import type { PriceBook } from "../../src/gateway/pricebook.js";
import { StaticPrincipalRegistry } from "../../src/gateway/principals.js";
import type { ProviderRoute } from "../../src/gateway/routes.js";

const priceBook: PriceBook = {
  version: "test-v1",
  effectiveFrom: "2026-08-01T00:00:00.000Z",
  entries: [
    {
      provider: "internal-maas",
      model: "gpt-x",
      inputPer1kUsd: 0.01,
      outputPer1kUsd: 0.03,
    },
  ],
};

describe("handleGatewayRequest", () => {
  let server: Server;
  let route: ProviderRoute;

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "gpt-x",
          usage: { prompt_tokens: 200, completion_tokens: 100 },
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
      priceBook,
      sink,
      principals: new StaticPrincipalRegistry(
        new Map([
          [
            "good-key",
            {
              principalId: "svc-1",
              tenant: "acme",
              team: "platform",
              actorType: "service" as const,
            },
          ],
        ]),
      ),
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      newId: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
    };
  }

  it("authenticates, forwards, meters, and emits a metadata-only event on success", async () => {
    const sink = new InMemoryEventSink();
    const response = await handleGatewayRequest(buildDeps(sink), {
      provider: "internal-maas",
      path: "/v1/chat",
      method: "POST",
      headers: { authorization: "Bearer good-key" },
      body: JSON.stringify({ model: "gpt-x" }),
    });

    expect(response.status).toBe(200);
    expect(sink.events).toHaveLength(1);
    const event = sink.events[0]!;
    expect(event.status).toBe("succeeded");
    expect(event.operation).toBe("model_call");
    expect(event.identity.principalId).toBe("svc-1");
    expect(event.tenantId).toBe("acme");
    expect(event.model).toEqual({ provider: "internal-maas", name: "gpt-x" });
    expect(event.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    expect(event.capture).toEqual({
      mode: "metadata_only",
      contentIncluded: false,
      redaction: "not_applicable",
      policyVersion: "2026-08-12.metadata-only",
    });
    expect(event.vendor).toEqual({ namespace: "maas.gateway", attributes: {} });
    expect(event.attributes["internal.cost_usd"]).toBeCloseTo(0.005, 6);
    expect(event.attributes["internal.price_book_version"]).toBe("test-v1");
  });

  it("carries caller-supplied run/trace/span ids through to the event", async () => {
    const sink = new InMemoryEventSink();
    await handleGatewayRequest(buildDeps(sink), {
      provider: "internal-maas",
      path: "/v1/chat",
      method: "POST",
      headers: {
        authorization: "Bearer good-key",
        "x-ai-run-id": "run-42",
        "x-ai-trace-id": "trace-42",
        "x-ai-span-id": "span-42",
      },
      body: "{}",
    });
    expect(sink.events[0]!.trace).toEqual({
      runId: "run-42",
      traceId: "trace-42",
      spanId: "span-42",
    });
  });

  it("still emits an event on auth failure, so coverage accounting sees the call", async () => {
    const sink = new InMemoryEventSink();
    const response = await handleGatewayRequest(buildDeps(sink), {
      provider: "internal-maas",
      path: "/v1/chat",
      method: "POST",
      headers: {},
    });
    expect(response.status).toBe(401);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.status).toBe("failed");
    // The real canonical schema rejects "model_call" without a model
    // (PR #1 superRefine); a rejection that never reached a model must
    // never claim to be one.
    expect(sink.events[0]!.operation).toBe("policy");
    expect(sink.events[0]!.attributes.error_class).toBe("unauthorized");
  });

  it("returns 404 for an unregistered provider without touching any upstream", async () => {
    const sink = new InMemoryEventSink();
    const response = await handleGatewayRequest(buildDeps(sink), {
      provider: "not-a-real-provider",
      path: "/v1/chat",
      method: "POST",
      headers: { authorization: "Bearer good-key" },
    });
    expect(response.status).toBe(404);
    expect(sink.events[0]!.operation).toBe("policy");
    expect(sink.events[0]!.attributes.error_class).toBe("unknown_provider");
  });

  it("blocks a path that would escape the route's origin before ever forwarding, and emits it as policy not model_call", async () => {
    const sink = new InMemoryEventSink();
    const response = await handleGatewayRequest(buildDeps(sink), {
      provider: "internal-maas",
      path: "http://127.0.0.1:1/steal",
      method: "GET",
      headers: { authorization: "Bearer good-key" },
    });
    expect(response.status).toBe(400);
    expect(sink.events[0]!.operation).toBe("policy");
    expect(sink.events[0]!.attributes.error_class).toBe(
      "path_escapes_route_origin",
    );
  });

  it("degrades to policy rather than an invalid model_call when a forwarded call's model can't be identified", async () => {
    const modelessServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => modelessServer.listen(0, resolve));
    try {
      const address = modelessServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const modelessRoute: ProviderRoute = {
        provider: "modeless-maas",
        baseUrl: `http://127.0.0.1:${port}`,
        upstreamAuthHeader: "x-upstream-key",
        upstreamApiKey: "secret",
      };
      const sink = new InMemoryEventSink();
      const deps = { ...buildDeps(sink), routes: [modelessRoute] };

      // Neither the request body nor the upstream response names a model,
      // so nothing in the pipeline can name one — this must not surface as
      // a schema-invalid "model_call" event with no model attached.
      const response = await handleGatewayRequest(deps, {
        provider: "modeless-maas",
        path: "/v1/anything",
        method: "POST",
        headers: { authorization: "Bearer good-key" },
        body: JSON.stringify({ prompt: "no model field here" }),
      });

      expect(response.status).toBe(200);
      expect(sink.events[0]!.model).toBeUndefined();
      expect(sink.events[0]!.operation).toBe("policy");
    } finally {
      await new Promise<void>((resolve) =>
        modelessServer.close(() => resolve()),
      );
    }
  });
});
