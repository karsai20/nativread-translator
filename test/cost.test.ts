import { test, expect } from "bun:test";
import {
  createCostState,
  addUsage,
  wouldExceedCeiling,
  estimateTokensFromChars,
} from "../lib/core/cost.ts";

test("accumulates usage and computes USD", () => {
  let state = createCostState(10);
  state = addUsage(state, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  expect(state.inputTokens).toBe(1_000_000);
  expect(state.outputTokens).toBe(1_000_000);
  // default profile: Gemini 2.5 Flash Standard, 0.30 input + 2.50 output per million
  expect(state.usd).toBeCloseTo(2.80, 5);
});

test("prices cache-hit input tokens at the cheaper rate", () => {
  let state = createCostState(10);
  // 1M input of which 800k was a cache hit, plus 1M output.
  state = addUsage(state, { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 1_000_000 });
  expect(state.cachedInputTokens).toBe(800_000);
  // fresh 200k @ 0.30 + cached 800k @ 0.075 + output 1M @ 2.50
  // = 0.06 + 0.06 + 2.50 = 2.62
  expect(state.usd).toBeCloseTo(2.62, 5);
});

test("usage without cache info falls back to full input price", () => {
  let state = createCostState(10);
  state = addUsage(state, { inputTokens: 1_000_000, outputTokens: 0 });
  expect(state.usd).toBeCloseTo(0.30, 5);
});

test("ceiling guard projects input+output cost", () => {
  const state = createCostState(1);
  // 1M input tokens projects ~ (0.30 + 2.50) = 2.80 USD > 1 ceiling
  expect(wouldExceedCeiling(state, 1_000_000)).toBe(true);
  expect(wouldExceedCeiling(state, 1000)).toBe(false);
});

test("estimateTokensFromChars uses the 4-chars-per-token rule", () => {
  expect(estimateTokensFromChars(400)).toBe(100);
});
