// Cost accounting + a hard per-book ceiling. DeepSeek bills per token; we accumulate
// reported usage and refuse to start a chunk that would push the book past the ceiling.

import type { TokenUsage } from "./translator";
import { CHARS_PER_TOKEN } from "./chunker";

// DeepSeek deepseek-v4-flash pricing (USD per 1M tokens), the model `deepseek-chat`
// now maps to. Input is billed at two rates: cache-miss (fresh) and the much cheaper
// cache-hit. We repeat the stable system prompt + glossary on every chunk, so DeepSeek
// serves a large share from cache — pricing those at the miss rate badly overestimates
// the bill. Splitting the two rates is what makes our number track the provider's.
// Source: https://api-docs.deepseek.com/quick_start/pricing
export const PRICE_INPUT_PER_MTOK = 0.14; // cache miss
export const PRICE_CACHED_INPUT_PER_MTOK = 0.0028; // cache hit
export const PRICE_OUTPUT_PER_MTOK = 0.28;

const MILLION = 1_000_000;

export interface CostState {
  inputTokens: number;
  /** Portion of inputTokens served from DeepSeek's cache (billed at the cache-hit rate). */
  cachedInputTokens: number;
  outputTokens: number;
  usd: number;
  ceilingUsd: number;
}

export function createCostState(ceilingUsd: number): CostState {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usd: 0, ceilingUsd };
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function priceOf(inputTokens: number, cachedInputTokens: number, outputTokens: number): number {
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (freshInput / MILLION) * PRICE_INPUT_PER_MTOK +
    (cachedInputTokens / MILLION) * PRICE_CACHED_INPUT_PER_MTOK +
    (outputTokens / MILLION) * PRICE_OUTPUT_PER_MTOK
  );
}

/** Fold one chunk's usage into the running total (immutable). */
export function addUsage(state: CostState, usage: TokenUsage): CostState {
  const inputTokens = state.inputTokens + usage.inputTokens;
  const cachedInputTokens = state.cachedInputTokens + (usage.cachedInputTokens ?? 0);
  const outputTokens = state.outputTokens + usage.outputTokens;
  return { ...state, inputTokens, cachedInputTokens, outputTokens, usd: priceOf(inputTokens, cachedInputTokens, outputTokens) };
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
