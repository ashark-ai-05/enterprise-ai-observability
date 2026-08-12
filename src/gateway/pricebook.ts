import type { TokenUsage } from "./meter.js";

/**
 * Versioned price book (D9: persist provider-reported usage AND a versioned
 * internal price book; never recompute history at today's prices). Callers
 * must pass the price book version that was active at request time when
 * re-pricing historical usage — `priceUsage` never mutates or looks up
 * "current" pricing implicitly.
 */
export interface PriceBookEntry {
  readonly provider: string;
  readonly model: string;
  readonly inputPer1kUsd: number;
  readonly outputPer1kUsd: number;
}

export interface PriceBook {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly entries: readonly PriceBookEntry[];
}

export function findPriceEntry(
  priceBook: PriceBook,
  provider: string,
  model: string,
): PriceBookEntry | undefined {
  return priceBook.entries.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
}

export function priceUsage(
  priceBook: PriceBook,
  provider: string,
  model: string,
  usage: TokenUsage,
): number | undefined {
  const entry = findPriceEntry(priceBook, provider, model);
  if (!entry) return undefined;
  const inputCost = ((usage.inputTokens ?? 0) / 1000) * entry.inputPer1kUsd;
  const outputCost = ((usage.outputTokens ?? 0) / 1000) * entry.outputPer1kUsd;
  return roundUsd(inputCost + outputCost);
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
