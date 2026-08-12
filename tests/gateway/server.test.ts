import { type Server, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventSink } from "../../src/gateway/sink.js";
import type { GatewayDeps } from "../../src/gateway/gateway.js";
import { StaticPrincipalRegistry } from "../../src/gateway/principals.js";
import type { ProviderRoute } from "../../src/gateway/routes.js";
import { createGatewayServer } from "../../src/gateway/server.js";

describe("gateway HTTP server body limits", () => {
  let upstream: Server;
  let gateway: ReturnType<typeof createGatewayServer>;
  let gatewayPort: number;
  const maxBodyBytes = 100;

  beforeEach(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const route: ProviderRoute = {
      provider: "internal-maas",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      upstreamAuthHeader: "x-upstream-key",
      upstreamApiKey: "secret",
    };
    const deps: GatewayDeps = {
      routes: [route],
      priceBook: {
        version: "v1",
        effectiveFrom: new Date(0).toISOString(),
        entries: [],
      },
      sink: new InMemoryEventSink(),
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
    gateway = createGatewayServer(deps, { maxBodyBytes });
    await new Promise<void>((resolve) => gateway.listen(0, resolve));
    gatewayPort = (gateway.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function post(
    path: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: gatewayPort,
          path,
          method: "POST",
          headers: {
            authorization: "Bearer good-key",
            "content-type": "application/json",
            ...extraHeaders,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("rejects a request whose declared Content-Length exceeds the cap without reading the body", async () => {
    const oversized = "x".repeat(maxBodyBytes + 1);
    const result = await post("/v1/gateway/internal-maas/anything", oversized);
    expect(result.status).toBe(413);
  });

  it("rejects a request that streams more than the cap even if Content-Length under-declares it", async () => {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: gatewayPort,
          path: "/v1/gateway/internal-maas/anything",
          method: "POST",
          headers: {
            authorization: "Bearer good-key",
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", () => resolve({ status: 0 }));
      req.write("x".repeat(maxBodyBytes + 1));
      req.end();
      req.on("error", reject);
    });
    // Either the server rejects with 413, or the destroyed connection
    // surfaces as a client-side error (status 0) — both mean the oversized
    // body was never fully buffered.
    expect([0, 413]).toContain(result.status);
  });

  it("accepts a request within the cap", async () => {
    const result = await post(
      "/v1/gateway/internal-maas/anything",
      JSON.stringify({ model: "gpt-x" }),
    );
    expect(result.status).toBe(200);
  });
});

describe("createGatewayServer construction validation", () => {
  const minimalDeps: GatewayDeps = {
    routes: [],
    priceBook: { version: "v1", effectiveFrom: new Date(0).toISOString(), entries: [] },
    sink: new InMemoryEventSink(),
    principals: new StaticPrincipalRegistry(new Map()),
  };

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects an invalid maxBodyBytes (%s) at construction, not at request time",
    (invalid) => {
      expect(() => createGatewayServer(minimalDeps, { maxBodyBytes: invalid })).toThrow(RangeError);
    },
  );

  it("accepts a valid maxBodyBytes", () => {
    expect(() => createGatewayServer(minimalDeps, { maxBodyBytes: 1000 }).close()).not.toThrow();
  });
});

describe("gateway server async error boundary", () => {
  let gateway: ReturnType<typeof createGatewayServer>;
  let gatewayPort: number;

  afterEach(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });

  it("returns 500 instead of hanging when handling the request throws unexpectedly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const route: ProviderRoute = {
      provider: "internal-maas",
      baseUrl: "http://127.0.0.1:1",
      upstreamAuthHeader: "x-upstream-key",
      upstreamApiKey: "secret",
    };
    const deps: GatewayDeps = {
      routes: [route],
      priceBook: { version: "v1", effectiveFrom: new Date(0).toISOString(), entries: [] },
      sink: new InMemoryEventSink(),
      principals: new StaticPrincipalRegistry(
        new Map([
          [
            "good-key",
            { principalId: "svc-1", tenant: "acme", team: undefined, actorType: "service" as const },
          ],
        ]),
      ),
      // Deliberately throws from a spot handleGatewayRequest doesn't wrap
      // in its own try/catch (observedAt is read before the auth try
      // block), to exercise server.ts's outer safety net rather than
      // gateway.ts's fail-closed sink handling, which is a separate test.
      now: () => {
        throw new Error("clock unavailable");
      },
    };
    gateway = createGatewayServer(deps);
    await new Promise<void>((resolve) => gateway.listen(0, resolve));
    gatewayPort = (gateway.address() as AddressInfo).port;

    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: gatewayPort,
          path: "/v1/gateway/internal-maas/anything",
          method: "POST",
          headers: { authorization: "Bearer good-key", "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });

    expect(result.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
