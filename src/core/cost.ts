// Cost accounting + a hard per-book ceiling.
//
// DeepSeek bills per token. We accumulate reported usage (or estimate when a provider
// doesn't report any) and refuse to start a chunk that would push the book past the
// ceiling, so a runaway job can't silently rack up cost.

import type { TokenUsage } from "./translator.ts";
import { CHARS_PER_TOKEN } from "./chunker.ts";

// DeepSeek deepseek-chat pricing (USD per 1M tokens), cache-miss rates. These are
// constants here; adjust if the provider's pricing changes.
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

/** Rough token estimate when a provider reports no usage (e.g. the fake provider). */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

/** Token estimate from a raw character count. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function priceOf(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / MILLION) * PRICE_INPUT_PER_MTOK +
    (outputTokens / MILLION) * PRICE_OUTPUT_PER_MTOK
  );
}

/** Fold one chunk's usage into the running total. Returns a new CostState (immutable). */
export function addUsage(state: CostState, usage: TokenUsage): CostState {
  const inputTokens = state.inputTokens + usage.inputTokens;
  const outputTokens = state.outputTokens + usage.outputTokens;
  return {
    ...state,
    inputTokens,
    outputTokens,
    usd: priceOf(inputTokens, outputTokens),
  };
}

/** Projected cost if we also spent `pendingTokens` more input tokens. */
export function wouldExceedCeiling(state: CostState, pendingInputTokens: number): boolean {
  const projected = priceOf(
    state.inputTokens + pendingInputTokens,
    // assume output ~= input as a conservative guard
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
