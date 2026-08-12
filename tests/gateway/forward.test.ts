import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forwardRequest } from "../../src/gateway/forward.js";
import type { ProviderRoute } from "../../src/gateway/routes.js";

describe("forwardRequest", () => {
  let server: Server;
  let route: ProviderRoute;
  let receivedAuthHeader: string | undefined;

  beforeEach(async () => {
    receivedAuthHeader = undefined;
    server = createServer((req, res) => {
      receivedAuthHeader = req.headers["x-upstream-key"] as string | undefined;
      if (req.url === "/v1/chat") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-x",
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    route = {
      provider: "internal-maas",
      baseUrl: `http://127.0.0.1:${port}`,
      upstreamAuthHeader: "x-upstream-key",
      upstreamApiKey: "upstream-secret",
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards the request and returns the parsed body", async () => {
    const result = await forwardRequest(route, "/v1/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-key",
      },
      body: JSON.stringify({ model: "gpt-x" }),
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      model: "gpt-x",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.errorClass).toBeUndefined();
  });

  it("injects the upstream credential and strips the caller's Authorization header", async () => {
    await forwardRequest(route, "/v1/chat", {
      method: "POST",
      headers: { authorization: "Bearer caller-key" },
      body: "{}",
    });
    expect(receivedAuthHeader).toBe("upstream-secret");
  });

  it("marks non-2xx upstream responses with an error class", async () => {
    const result = await forwardRequest(route, "/does-not-exist", {
      method: "GET",
      headers: {},
    });
    expect(result.status).toBe(404);
    expect(result.errorClass).toBe("upstream_404");
  });

  it("returns 502 with a fetch error class when the upstream is unreachable", async () => {
    const deadRoute: ProviderRoute = {
      ...route,
      baseUrl: "http://127.0.0.1:1",
    };
    const result = await forwardRequest(deadRoute, "/v1/chat", {
      method: "GET",
      headers: {},
    });
    expect(result.status).toBe(502);
    expect(result.errorClass).toBeDefined();
  });

  describe("path cannot escape the route's origin (SSRF)", () => {
    let attacker: Server;
    let attackerPort: number;
    let attackerHit: boolean;

    beforeEach(async () => {
      attackerHit = false;
      attacker = createServer((_req, res) => {
        attackerHit = true;
        res.writeHead(200).end("stolen");
      });
      await new Promise<void>((resolve) => attacker.listen(0, resolve));
      const address = attacker.address();
      attackerPort = typeof address === "object" && address ? address.port : 0;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => attacker.close(() => resolve()));
    });

    it("blocks an absolute-URL path and never sends the upstream credential to it", async () => {
      const result = await forwardRequest(
        route,
        `http://127.0.0.1:${attackerPort}/steal`,
        { method: "GET", headers: {} },
      );
      expect(result.status).toBe(400);
      expect(result.errorClass).toBe("path_escapes_route_scope");
      expect(attackerHit).toBe(false);
    });

    it("blocks a backslash-normalized protocol-relative path", async () => {
      // WHATWG URL parsers normalize a leading "\\" to "//" for special
      // schemes, so this becomes network-path-relative (i.e. a different
      // host) only *after* parsing — the raw string itself is not caught by
      // the leading-slash strip, which is why the post-parse origin check,
      // not a string blocklist, is what actually has to catch this.
      const result = await forwardRequest(
        route,
        `\\\\127.0.0.1:${attackerPort}/steal`,
        { method: "GET", headers: {} },
      );
      expect(result.status).toBe(400);
      expect(result.errorClass).toBe("path_escapes_route_scope");
      expect(attackerHit).toBe(false);
    });

    it("folds a leading-slash protocol-relative-looking path into the same origin instead of escaping", async () => {
      // After stripping leading forward slashes, "//host/steal" becomes
      // "host/steal" — a harmless relative path segment on the real route,
      // not a host. Confirms the attacker is unreachable via this form too,
      // without needing it to hit the 400 path specifically.
      await forwardRequest(route, `//127.0.0.1:${attackerPort}/steal`, {
        method: "GET",
        headers: {},
      });
      expect(attackerHit).toBe(false);
    });

    it("does not treat a percent-encoded absolute URL as a scheme, so it stays same-origin", async () => {
      const result = await forwardRequest(
        route,
        `http%3A%2F%2F127.0.0.1%3A${attackerPort}%2Fsteal`,
        { method: "GET", headers: {} },
      );
      // "http%3A..." doesn't parse as a scheme, so this is a same-origin
      // path on the configured route, not a redirect to the attacker.
      expect(result.status).not.toBe(400);
      expect(attackerHit).toBe(false);
    });

    it("never follows a same-origin upstream's redirect to the attacker", async () => {
      // Same-origin request, but the *response* is a 302 pointing off-host —
      // origin/path-scope checks on the request path can't catch this, only
      // refusing to follow redirects at all can.
      server.close();
      server = createServer((req, res) => {
        if (req.url === "/v1/chat") {
          res.writeHead(302, {
            location: `http://127.0.0.1:${attackerPort}/steal`,
          });
          res.end();
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectingRoute: ProviderRoute = { ...route, baseUrl: `http://127.0.0.1:${port}` };

      const result = await forwardRequest(redirectingRoute, "/v1/chat", {
        method: "GET",
        headers: {},
      });

      expect(result.status).toBe(302);
      expect(result.errorClass).toBe("upstream_redirect_302");
      expect(attackerHit).toBe(false);
    });
  });

  describe("a route scoped to a sub-path cannot be escaped by traversal", () => {
    let scopedRoute: ProviderRoute;
    let requestedUrl: string | undefined;

    beforeEach(async () => {
      server.close();
      requestedUrl = undefined;
      server = createServer((req, res) => {
        requestedUrl = req.url;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      scopedRoute = {
        provider: "internal-maas",
        baseUrl: `http://127.0.0.1:${port}/approved/v1`,
        upstreamAuthHeader: "x-upstream-key",
        upstreamApiKey: "upstream-secret",
      };
    });

    it("blocks a literal .. traversal out of the configured prefix", async () => {
      const result = await forwardRequest(scopedRoute, "../../admin/secret", {
        method: "GET",
        headers: {},
      });
      expect(result.status).toBe(400);
      expect(result.errorClass).toBe("path_escapes_route_scope");
      expect(requestedUrl).toBeUndefined();
    });

    it("blocks a percent-encoded '..' the same as a literal one", async () => {
      // Verified empirically before writing this assertion, because the
      // intuitive guess is wrong: the WHATWG URL spec special-cases
      // ".%2e", "%2e.", and "%2e%2e" as double-dot segments during path
      // normalization (unlike other percent-encoded characters, which are
      // left alone), so `new URL()` collapses this exactly like ".." would
      // — meaning the origin+prefix check catches it for the same reason,
      // not a separate one.
      const result = await forwardRequest(scopedRoute, "%2e%2e/admin", {
        method: "GET",
        headers: {},
      });
      expect(result.status).toBe(400);
      expect(result.errorClass).toBe("path_escapes_route_scope");
      expect(requestedUrl).toBeUndefined();
    });

    it("allows a normal request within the configured prefix", async () => {
      const result = await forwardRequest(scopedRoute, "chat/completions", {
        method: "GET",
        headers: {},
      });
      expect(result.status).toBe(200);
      expect(requestedUrl).toBe("/approved/v1/chat/completions");
    });
  });

  it("strips a caller-supplied duplicate of the upstream-auth header regardless of case, so only the real secret reaches upstream", async () => {
    const receivedHeaders: Record<string, string | string[] | undefined> = {};
    server.close();
    server = createServer((req, res) => {
      Object.assign(receivedHeaders, req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const localRoute: ProviderRoute = {
      provider: "internal-maas",
      baseUrl: `http://127.0.0.1:${port}`,
      upstreamAuthHeader: "x-upstream-key",
      upstreamApiKey: "real-secret",
    };

    await forwardRequest(localRoute, "/v1/chat", {
      method: "GET",
      // Differently-cased duplicate of the configured auth header, supplied
      // by the caller. A plain-object header merge would keep both
      // "X-Upstream-Key" and "x-upstream-key" as distinct JS object keys.
      headers: { "X-Upstream-Key": "attacker-supplied-value" },
    });

    expect(receivedHeaders["x-upstream-key"]).toBe("real-secret");
    expect(receivedHeaders["X-Upstream-Key"]).toBeUndefined();
  });

  describe("upstream response size cap", () => {
    it("aborts and returns 502 when the upstream response exceeds the cap", async () => {
      server.close();
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("x".repeat(1000));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const localRoute: ProviderRoute = { ...route, baseUrl: `http://127.0.0.1:${port}` };

      const result = await forwardRequest(
        localRoute,
        "/v1/chat",
        { method: "GET", headers: {} },
        { maxResponseBytes: 100 },
      );

      expect(result.status).toBe(502);
      expect(result.errorClass).toBe("upstream_response_too_large");
    });

    it("passes through a response within the cap", async () => {
      const result = await forwardRequest(
        route,
        "/v1/chat",
        { method: "GET", headers: {} },
        { maxResponseBytes: 1_000_000 },
      );
      expect(result.status).toBe(200);
    });
  });

  describe("upstream timeout", () => {
    it("aborts and classifies distinctly when the upstream never responds", async () => {
      server.close();
      server = createServer(() => {
        // Never call res.end() — simulates a stalled upstream.
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const stalledRoute: ProviderRoute = { ...route, baseUrl: `http://127.0.0.1:${port}` };

      const startedAt = Date.now();
      const result = await forwardRequest(
        stalledRoute,
        "/v1/chat",
        { method: "GET", headers: {} },
        { timeoutMs: 50 },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe(502);
      expect(result.errorClass).toBe("upstream_timeout");
      // Loose bound — this asserts the timeout fired near its configured
      // value, not that it waited for some much longer default.
      expect(elapsedMs).toBeLessThan(2000);
    });

    it("does not time out a response that arrives comfortably within the deadline", async () => {
      const result = await forwardRequest(
        route,
        "/v1/chat",
        { method: "GET", headers: {} },
        { timeoutMs: 5000 },
      );
      expect(result.status).toBe(200);
      expect(result.errorClass).toBeUndefined();
    });
  });
});
