import type { CanonicalEvent } from "../contracts/events.js";

export type TokenUsage = NonNullable<CanonicalEvent["usage"]>;

/**
 * Extract token usage from a provider response body. Providers disagree on
 * field names; support the shapes we've actually seen rather than guessing
 * at ones we haven't. Returns undefined (not zeros) when usage can't be
 * found — a metered-but-unknown call must never look identical to a
 * verified zero-token call in downstream cost reporting.
 */
export function extractUsage(body: unknown): TokenUsage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;

  const usage = record.usage;
  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;

    // OpenAI-compatible: prompt_tokens / completion_tokens
    if (
      isFiniteNumber(u.prompt_tokens) ||
      isFiniteNumber(u.completion_tokens)
    ) {
      return {
        inputTokens: numberOr(u.prompt_tokens, 0),
        outputTokens: numberOr(u.completion_tokens, 0),
      };
    }

    // Anthropic-compatible: input_tokens / output_tokens
    if (isFiniteNumber(u.input_tokens) || isFiniteNumber(u.output_tokens)) {
      return {
        inputTokens: numberOr(u.input_tokens, 0),
        outputTokens: numberOr(u.output_tokens, 0),
      };
    }
  }

  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}
