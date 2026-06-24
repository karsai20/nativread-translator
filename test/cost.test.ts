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
  // deepseek-v4-flash: 0.14 input (miss) + 0.28 output per million
  expect(state.usd).toBeCloseTo(0.42, 5);
});

test("prices cache-hit input tokens at the cheaper rate", () => {
  let state = createCostState(10);
  // 1M input of which 800k was a cache hit, plus 1M output.
  state = addUsage(state, { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 1_000_000 });
  expect(state.cachedInputTokens).toBe(800_000);
  // fresh 200k @ 0.14 + cached 800k @ 0.0028 + output 1M @ 0.28
  // = 0.028 + 0.00224 + 0.28 = 0.31024
  expect(state.usd).toBeCloseTo(0.31024, 5);
});

test("usage without cache info falls back to full input price", () => {
  let state = createCostState(10);
  state = addUsage(state, { inputTokens: 1_000_000, outputTokens: 0 });
  expect(state.usd).toBeCloseTo(0.14, 5);
});

test("ceiling guard projects input+output cost", () => {
  const state = createCostState(0.3);
  // 1M input tokens projects ~ (0.14 + 0.28) = 0.42 USD > 0.3 ceiling
  expect(wouldExceedCeiling(state, 1_000_000)).toBe(true);
  expect(wouldExceedCeiling(state, 1000)).toBe(false);
});

test("estimateTokensFromChars uses the 4-chars-per-token rule", () => {
  expect(estimateTokensFromChars(400)).toBe(100);
});
