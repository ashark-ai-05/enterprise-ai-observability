import { fetch } from "undici";
import type { Response as UndiciResponse } from "undici";
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

/** Upstream responses are small JSON completions, not downloads. */
export const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;

/** A stalled MaaS endpoint must not hold a gateway connection indefinitely. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ForwardOptions {
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
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
 * entirely, per the WHATWG URL spec, and a `..` segment can walk out of a
 * route intentionally scoped to a sub-path even while staying same-origin.
 * The target is resolved and both its origin *and* its path prefix are
 * checked against the route before anything is sent.
 *
 * Redirects are never followed (`redirect: "manual"`): an upstream that
 * returns a 3xx to a different host is functionally the same
 * credential-exfiltration shape as an escaped path, and the standard
 * `Authorization`-stripping behavior some fetch implementations apply on
 * cross-origin redirect is not guaranteed for `route.upstreamAuthHeader`,
 * which is an arbitrary configured header name, not necessarily
 * `Authorization`.
 *
 * A hard deadline (`AbortController`, default 30s) bounds every call: a
 * stalled upstream must not be able to hold a gateway connection — and the
 * concurrency slot behind it — indefinitely. Timeout is classified
 * distinctly (`upstream_timeout`) rather than folded into the generic
 * fetch-error path, since "the upstream is slow" and "the upstream is
 * unreachable" call for different operational responses.
 */
export async function forwardRequest(
  route: ProviderRoute,
  path: string,
  init: ForwardRequestInit,
  options: ForwardOptions = {},
): Promise<ForwardResult> {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = resolveTargetUrl(route, path);
  if (!url) {
    return {
      status: 400,
      bodyText: "",
      body: undefined,
      latencyMs: 0,
      errorClass: "path_escapes_route_scope",
    };
  }

  const upstreamAuthHeaderLower = route.upstreamAuthHeader.toLowerCase();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers)) {
    const lower = key.toLowerCase();
    if (STRIPPED_HEADERS.has(lower) || lower === upstreamAuthHeaderLower) continue;
    headers[key] = value;
  }
  headers[route.upstreamAuthHeader] = route.upstreamApiKey;

  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const latencyMs = performance.now() - startedAt;

    // redirect: "manual" means undici hands back the 3xx itself rather than
    // following it — this *is* the block, not a follow-up decision.
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel();
      return {
        status: response.status,
        bodyText: "",
        body: undefined,
        latencyMs,
        errorClass: `upstream_redirect_${response.status}`,
      };
    }

    const bodyResult = await readCapped(response, maxResponseBytes);
    if (!bodyResult.ok) {
      return {
        status: 502,
        bodyText: "",
        body: undefined,
        latencyMs: performance.now() - startedAt,
        errorClass: "upstream_response_too_large",
      };
    }
    return {
      status: response.status,
      bodyText: bodyResult.text,
      body: safeParseJson(bodyResult.text),
      latencyMs: performance.now() - startedAt,
      errorClass: response.ok ? undefined : `upstream_${response.status}`,
    };
  } catch (error) {
    const latencyMs = performance.now() - startedAt;
    return {
      status: 502,
      bodyText: "",
      body: undefined,
      latencyMs,
      errorClass: isAbortError(error) ? "upstream_timeout" : classifyError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function classifyError(error: unknown): string {
  return error instanceof Error ? error.name || "fetch_error" : "fetch_error";
}

/**
 * Read a response body up to `maxBytes`, checking the running total against
 * every chunk rather than trusting a declared `content-length` — the same
 * discipline `readBody` applies on the request side in server.ts. Aborts
 * and cancels the stream the moment the cap is exceeded, whether or not the
 * upstream declared a length at all.
 */
async function readCapped(
  response: UndiciResponse,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!response.body) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Resolve `path` against `route.baseUrl` and return the target URL only if
 * it stays within the route's origin *and* its base path prefix.
 * Construct-then-verify rather than pattern-matching the input string:
 * absolute URLs, protocol-relative (`//host/...`), backslash variants
 * (some URL parsers normalize `\` to `/`), and `..` segments all resolve
 * down to a single `URL` object before the check runs, so there is no
 * separate blocklist of "bad forms" to keep up to date. This includes
 * percent-encoded traversal (`%2e%2e`): the WHATWG URL spec special-cases
 * `.%2e`/`%2e.`/`%2e%2e` as double-dot segments during path normalization
 * (verified against Node's actual `URL` behavior, not assumed), so it
 * collapses exactly like a literal `..` would, and the prefix check below
 * catches it for the same reason.
 */
function resolveTargetUrl(route: ProviderRoute, path: string): URL | undefined {
  const base = new URL(ensureTrailingSlash(route.baseUrl));
  let target: URL;
  try {
    target = new URL(path.replace(/^\/+/, ""), base);
  } catch {
    return undefined;
  }
  if (target.origin !== base.origin) return undefined;
  if (!target.pathname.startsWith(base.pathname)) return undefined;
  return target;
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
