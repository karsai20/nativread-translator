// Cost accounting + a hard per-book ceiling. Providers bill per token; we accumulate
// reported usage and refuse to start a chunk that would push the book past the ceiling.

import type { TokenUsage } from "./translator";
import { CHARS_PER_TOKEN } from "./chunker";

// Default pricing profile (USD per 1M tokens). This tracks Gemini 2.5 Flash
// Standard text pricing. Providers differ by model, so production deployments
// should keep COST_CEILING_USD conservative and treat dashboard billing as authoritative.
export const PRICE_INPUT_PER_MTOK = 0.30; // cache miss
export const PRICE_CACHED_INPUT_PER_MTOK = 0.03; // cache hit (implicit context cache)
export const PRICE_OUTPUT_PER_MTOK = 2.50;

const MILLION = 1_000_000;

export interface PriceProfile {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

const DEFAULT_PROFILE: PriceProfile = {
  inputPerMTok: PRICE_INPUT_PER_MTOK,
  cachedInputPerMTok: PRICE_CACHED_INPUT_PER_MTOK,
  outputPerMTok: PRICE_OUTPUT_PER_MTOK,
};

/**
 * Per-model list price, matched on model-id prefix so dated/preview suffixes resolve to
 * the same profile. Without this a book translated on a premium tier is billed in the UI
 * at flash rates — a 5x understatement, and a cost ceiling that never trips.
 * Longest prefix wins, so "-lite" variants are not shadowed by their base model.
 */
const PRICES: Record<string, PriceProfile> = {
  "gemini-3.6-flash": { inputPerMTok: 1.50, cachedInputPerMTok: 0.15, outputPerMTok: 7.50 },
  "gemini-3.5-flash": { inputPerMTok: 1.50, cachedInputPerMTok: 0.15, outputPerMTok: 9.00 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.30, cachedInputPerMTok: 0.03, outputPerMTok: 2.50 },
  "gemini-3.1-flash-lite": { inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 1.50 },
  "gemini-2.5-flash": DEFAULT_PROFILE,
  "gemini-2.5-flash-lite": { inputPerMTok: 0.10, cachedInputPerMTok: 0.01, outputPerMTok: 0.40 },
  "gemini-2.5-pro": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10.00 },
};

/** List price for a model id, or the conservative default for anything unknown. */
export function priceProfileFor(model?: string): PriceProfile {
  if (!model) return DEFAULT_PROFILE;
  const match = Object.keys(PRICES)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICES[match]! : DEFAULT_PROFILE;
}

export interface CostState {
  inputTokens: number;
  /** Portion of inputTokens served from a provider cache, if the adapter reports it. */
  cachedInputTokens: number;
  outputTokens: number;
  usd: number;
  ceilingUsd: number;
  /** Resolved at job start so a manifest stays priced at what the run actually cost. */
  pricing?: PriceProfile;
}

export function createCostState(ceilingUsd: number, model?: string): CostState {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    usd: 0,
    ceilingUsd,
    pricing: priceProfileFor(model),
  };
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function priceOf(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  profile: PriceProfile = DEFAULT_PROFILE,
): number {
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (freshInput / MILLION) * profile.inputPerMTok +
    (cachedInputTokens / MILLION) * profile.cachedInputPerMTok +
    (outputTokens / MILLION) * profile.outputPerMTok
  );
}

/** Fold one chunk's usage into the running total (immutable). */
export function addUsage(state: CostState, usage: TokenUsage): CostState {
  const inputTokens = state.inputTokens + usage.inputTokens;
  const cachedInputTokens = state.cachedInputTokens + (usage.cachedInputTokens ?? 0);
  const outputTokens = state.outputTokens + usage.outputTokens;
  return {
    ...state,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    usd: priceOf(inputTokens, cachedInputTokens, outputTokens, state.pricing),
  };
}

/**
 * Projected cost if we also spent `pendingInputTokens` more input tokens. Treats the
 * pending tokens as cache misses (the conservative direction for a spend gate).
 */
export function wouldExceedCeiling(state: CostState, pendingInputTokens: number): boolean {
  const projected = priceOf(
    state.inputTokens + pendingInputTokens,
    state.cachedInputTokens,
    state.outputTokens + pendingInputTokens,
    state.pricing,
  );
  return projected > state.ceilingUsd;
}

export class CostCeilingError extends Error {
  constructor(public readonly state: CostState) {
    super(
      `Cost ceiling of $${state.ceilingUsd.toFixed(2)} would be exceeded ` +
        `(spent $${state.usd.toFixed(4)} so far). Aborting before overrun.`,
    );
    this.name = "CostCeilingError";
  }
}
