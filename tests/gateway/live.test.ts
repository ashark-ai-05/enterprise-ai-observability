import { describe, expect, it } from "vitest";
import { InMemoryEventSink } from "../../src/gateway/sink.js";
import { handleGatewayRequest } from "../../src/gateway/gateway.js";
import { StaticPrincipalRegistry } from "../../src/gateway/principals.js";

/**
 * Opt-in integration test against a real MaaS endpoint. No credentials are
 * available in this environment, so it skips rather than failing — same
 * pattern as EIL's live connector tests and Opus's Amp archiver. Run with:
 *
 *   MAAS_LIVE_BASE_URL=... MAAS_LIVE_API_KEY=... MAAS_LIVE_MODEL=... pnpm test
 */
const baseUrl = process.env.MAAS_LIVE_BASE_URL;
const apiKey = process.env.MAAS_LIVE_API_KEY;
const model = process.env.MAAS_LIVE_MODEL;

describe.skipIf(!baseUrl || !apiKey || !model)("live MaaS gateway", () => {
  it("forwards a real request and captures real usage", async () => {
    const sink = new InMemoryEventSink();
    const response = await handleGatewayRequest(
      {
        routes: [
          {
            provider: "live-maas",
            baseUrl: baseUrl!,
            upstreamAuthHeader: "authorization",
            upstreamApiKey: `Bearer ${apiKey}`,
          },
        ],
        priceBook: {
          version: "live-check",
          effectiveFrom: new Date().toISOString(),
          entries: [],
        },
        sink,
        principals: new StaticPrincipalRegistry(
          new Map([
            [
              "gateway-key",
              {
                principalId: "live-check",
                tenant: "live",
                team: undefined,
                actorType: "service" as const,
              },
            ],
          ]),
        ),
      },
      {
        provider: "live-maas",
        path: "/chat/completions",
        method: "POST",
        headers: {
          authorization: "Bearer gateway-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "user", content: "reply with the single word: pong" },
          ],
          max_tokens: 5,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.usage).toBeDefined();
  });
});
