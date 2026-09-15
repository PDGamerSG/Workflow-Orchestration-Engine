import type { Usage } from "../engine/types";

/** Prices in USD: per million input and output tokens, and per thousand search calls. */
export type Pricing = { inputPerM: number; outputPerM: number; searchPerK: number };

// gemini-3.5-flash list prices as of September 2026.
export const GEMINI_FLASH_PRICING: Pricing = { inputPerM: 1.5, outputPerM: 9, searchPerK: 14 };

export function costUsd(usage: Usage, pricing: Pricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerM +
    (usage.outputTokens / 1_000_000) * pricing.outputPerM +
    (usage.searchCalls / 1_000) * pricing.searchPerK
  );
}
