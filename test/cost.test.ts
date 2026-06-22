import { test, expect } from "bun:test";
import {
  createCostState,
  addUsage,
  wouldExceedCeiling,
  estimateTokensFromChars,
} from "../src/core/cost.ts";

test("accumulates usage and computes USD", () => {
  let state = createCostState(10);
  state = addUsage(state, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  expect(state.inputTokens).toBe(1_000_000);
  expect(state.outputTokens).toBe(1_000_000);
  // 0.27 + 1.10 per million
  expect(state.usd).toBeCloseTo(1.37, 5);
});

test("ceiling guard projects input+output cost", () => {
  const state = createCostState(0.5);
  // 1M input tokens projects ~ (0.27 + 1.10) = 1.37 USD > 0.5 ceiling
  expect(wouldExceedCeiling(state, 1_000_000)).toBe(true);
  expect(wouldExceedCeiling(state, 1000)).toBe(false);
});

test("estimateTokensFromChars uses the 4-chars-per-token rule", () => {
  expect(estimateTokensFromChars(400)).toBe(100);
});
