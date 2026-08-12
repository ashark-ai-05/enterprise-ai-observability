import { fetch } from "undici";
import type { ProviderRoute } from "./routes.js";

export interface ForwardRequestInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface ForwardResult {
  readonly status: number;
  readonly bodyText: string;
  readonly body: unknown;
  readonly latencyMs: number;
  readonly errorClass: string | undefined;
}

/**
 * Headers stripped before forwarding, beyond `authorization` (which is
 * replaced with the upstream credential). Hop-by-hop headers are meaningful
 * only for the client<->gateway leg; forwarding them to the upstream leg is
 * incorrect at best (a stale `content-length` after body re-serialization,
 * the wrong `host`) and a smuggling vector at worst.
 */
const STRIPPED_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Forward a request to the upstream MaaS endpoint. Strips hop-by-hop and
 * caller-auth headers and injects the gateway's own upstream credential —
 * callers authenticate to the gateway, never to the provider directly
 * (that's the whole point of putting a gateway in front of MaaS).
 *
 * `path` is caller-supplied (it comes off the incoming request URL) and is
 * never trusted to stay within `route.baseUrl` on its own: an absolute or
 * protocol-relative value passed to `new URL(path, base)` escapes `base`
 * entirely, per the WHATWG URL spec, and would hand `upstreamApiKey` to
 * whatever host the caller named — a credential-bearing SSRF. The target is
 * resolved and its origin is checked against the route's origin before
 * anything is sent.
 */
export async function forwardRequest(
  route: ProviderRoute,
  path: string,
  init: ForwardRequestInit,
): Promise<ForwardResult> {
  const url = resolveTargetUrl(route, path);
  if (!url) {
    return {
      status: 400,
      bodyText: "",
      body: undefined,
      latencyMs: 0,
      errorClass: "path_escapes_route_origin",
    };
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers)) {
    if (!STRIPPED_HEADERS.has(key.toLowerCase())) headers[key] = value;
  }
  headers[route.upstreamAuthHeader] = route.upstreamApiKey;

  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const bodyText = await response.text();
    const latencyMs = performance.now() - startedAt;
    return {
      status: response.status,
      bodyText,
      body: safeParseJson(bodyText),
      latencyMs,
      errorClass: response.ok ? undefined : `upstream_${response.status}`,
    };
  } catch (error) {
    const latencyMs = performance.now() - startedAt;
    return {
      status: 502,
      bodyText: "",
      body: undefined,
      latencyMs,
      errorClass:
        error instanceof Error ? error.name || "fetch_error" : "fetch_error",
    };
  }
}

/**
 * Resolve `path` against `route.baseUrl` and return the target URL only if
 * its origin still matches the route's origin. Construct-then-verify rather
 * than pattern-matching the input string: absolute URLs, protocol-relative
 * (`//host/...`), backslash variants (browsers, and some URL parsers,
 * normalize `\` to `/`), and percent-encoded traversal all resolve down to
 * a single `URL` object before the check runs, so there is no separate
 * blocklist of "bad forms" to keep up to date.
 */
function resolveTargetUrl(route: ProviderRoute, path: string): URL | undefined {
  const base = new URL(ensureTrailingSlash(route.baseUrl));
  let target: URL;
  try {
    target = new URL(path.replace(/^\/+/, ""), base);
  } catch {
    return undefined;
  }
  return target.origin === base.origin ? target : undefined;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function safeParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
