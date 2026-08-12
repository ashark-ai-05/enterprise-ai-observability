import { describe, expect, it } from "vitest";
import { priceUsage } from "../../src/gateway/pricebook.js";
import type { PriceBook } from "../../src/gateway/pricebook.js";

const priceBook: PriceBook = {
  version: "2026-08-01.v1",
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

describe("priceUsage", () => {
  it("prices input and output tokens independently", () => {
    const cost = priceUsage(priceBook, "internal-maas", "gpt-x", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(0.01 + 0.015, 6);
  });

  it("returns undefined for a provider/model not in the book, never a guessed price", () => {
    const cost = priceUsage(priceBook, "internal-maas", "unknown-model", {
      inputTokens: 100,
      outputTokens: 100,
    });
    expect(cost).toBeUndefined();
  });

  it("never uses a price book version other than the one passed in", () => {
    // A stale/historical price book, deliberately different from "current"
    // pricing, must reprice history without any implicit lookup.
    const historicalBook: PriceBook = {
      version: "2026-01-01.v0",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          provider: "internal-maas",
          model: "gpt-x",
          inputPer1kUsd: 0.02,
          outputPer1kUsd: 0.06,
        },
      ],
    };
    const cost = priceUsage(historicalBook, "internal-maas", "gpt-x", {
      inputTokens: 1000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.02, 6);
  });
});
