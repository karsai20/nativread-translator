// Cost accounting + a hard per-book ceiling. DeepSeek bills per token; we accumulate
// reported usage and refuse to start a chunk that would push the book past the ceiling.

import type { TokenUsage } from "./translator";
import { CHARS_PER_TOKEN } from "./chunker";

// DeepSeek deepseek-chat pricing (USD per 1M tokens), cache-miss rates.
export const PRICE_INPUT_PER_MTOK = 0.27;
export const PRICE_OUTPUT_PER_MTOK = 1.1;

const MILLION = 1_000_000;

export interface CostState {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ceilingUsd: number;
}

export function createCostState(ceilingUsd: number): CostState {
  return { inputTokens: 0, outputTokens: 0, usd: 0, ceilingUsd };
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function priceOf(inputTokens: number, outputTokens: number): number {
  return (inputTokens / MILLION) * PRICE_INPUT_PER_MTOK + (outputTokens / MILLION) * PRICE_OUTPUT_PER_MTOK;
}

/** Fold one chunk's usage into the running total (immutable). */
export function addUsage(state: CostState, usage: TokenUsage): CostState {
  const inputTokens = state.inputTokens + usage.inputTokens;
  const outputTokens = state.outputTokens + usage.outputTokens;
  return { ...state, inputTokens, outputTokens, usd: priceOf(inputTokens, outputTokens) };
}

/** Projected cost if we also spent `pendingInputTokens` more input tokens. */
export function wouldExceedCeiling(state: CostState, pendingInputTokens: number): boolean {
  const projected = priceOf(state.inputTokens + pendingInputTokens, state.outputTokens + pendingInputTokens);
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
