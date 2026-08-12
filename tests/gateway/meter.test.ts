import { describe, expect, it } from "vitest";
import { extractUsage } from "../../src/gateway/meter.js";

describe("extractUsage", () => {
  it("parses OpenAI-compatible usage", () => {
    const usage = extractUsage({
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 40 });
  });

  it("parses Anthropic-compatible usage", () => {
    const usage = extractUsage({
      usage: { input_tokens: 20, output_tokens: 8 },
    });
    expect(usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it("returns undefined rather than zeros when usage is absent", () => {
    expect(extractUsage({ id: "resp_1" })).toBeUndefined();
    expect(extractUsage(undefined)).toBeUndefined();
    expect(extractUsage("not an object")).toBeUndefined();
    expect(extractUsage(null)).toBeUndefined();
  });
});
