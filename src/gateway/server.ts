import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import type { GatewayDeps } from "./gateway.js";
import { handleGatewayRequest } from "./gateway.js";

const ROUTE_PREFIX = "/v1/gateway/";

/** Gateway payloads are small JSON chat/completion requests, not uploads. */
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface GatewayServerOptions {
  readonly maxBodyBytes?: number;
}

class PayloadTooLargeError extends Error {}

/**
 * Minimal HTTP entry point over handleGatewayRequest. Kept deliberately
 * separate from gateway.ts so the core logic is testable without spinning
 * up a socket.
 */
export function createGatewayServer(
  deps: GatewayDeps,
  options: GatewayServerOptions = {},
) {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return createServer((req, res) => {
    void handleHttpRequest(deps, req, res, maxBodyBytes);
  });
}

async function handleHttpRequest(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const url = req.url ?? "/";
  if (!url.startsWith(ROUTE_PREFIX)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "payload too large" }));
    req.destroy();
    return;
  }

  const rest = url.slice(ROUTE_PREFIX.length);
  const separatorIndex = rest.indexOf("/");
  const provider = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);
  const path = separatorIndex === -1 ? "" : rest.slice(separatorIndex + 1);

  let body: string;
  try {
    body = await readBody(req, maxBodyBytes);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid request body" }));
    return;
  }

  const headers = flattenHeaders(req.headers);

  const result = await handleGatewayRequest(deps, {
    provider,
    path,
    method: req.method ?? "GET",
    headers,
    ...(body.length > 0 ? { body } : {}),
  });

  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(result.body);
}

/**
 * `content-length` is a declared value, not a guarantee — a client can lie
 * or use chunked transfer-encoding with no length at all. The cap is
 * enforced against bytes actually received, and the connection is
 * destroyed the moment it's exceeded rather than buffering further.
 */
function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function flattenHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") flat[key] = value;
    else if (Array.isArray(value)) flat[key] = value.join(", ");
  }
  return flat;
}
