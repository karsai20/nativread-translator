import { test, expect } from "bun:test";
import {
  createCostState,
  addUsage,
  wouldExceedCeiling,
  estimateTokensFromChars,
  priceProfileFor,
} from "../lib/core/cost.ts";

test("prices a job at its own model's rate, not the flash default", () => {
  let premium = createCostState(10, "gemini-3.6-flash");
  premium = addUsage(premium, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  // 1.50 input + 7.50 output, not the 0.30/2.50 default profile.
  expect(premium.usd).toBeCloseTo(9.0, 5);

  // A ceiling set for flash prices must actually trip on a premium model.
  expect(wouldExceedCeiling(createCostState(1, "gemini-3.6-flash"), 500_000)).toBe(true);
  expect(wouldExceedCeiling(createCostState(1, "gemini-2.5-flash"), 100_000)).toBe(false);
});

test("model ids resolve by longest matching prefix, with a safe fallback", () => {
  // "-lite" must not be shadowed by its base model's (much pricier) profile.
  expect(priceProfileFor("gemini-3.5-flash-lite").outputPerMTok).toBe(2.5);
  expect(priceProfileFor("gemini-3.5-flash").outputPerMTok).toBe(9.0);
  // Dated / preview suffixes resolve to the same profile.
  expect(priceProfileFor("gemini-2.5-pro-preview-06-05").outputPerMTok).toBe(10.0);
  // Unknown models fall back to the documented default rather than pricing at zero.
  expect(priceProfileFor("some-unreleased-model").outputPerMTok).toBe(2.5);
  expect(priceProfileFor(undefined).inputPerMTok).toBe(0.3);
});

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
  // fresh 200k @ 0.30 + cached 800k @ 0.03 + output 1M @ 2.50
  // = 0.06 + 0.024 + 2.50 = 2.584
  expect(state.usd).toBeCloseTo(2.584, 5);
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
