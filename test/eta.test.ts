import { test, expect } from "bun:test";

import { jobMetrics } from "../lib/core/eta.ts";
import type { JobState } from "../lib/core/job.ts";

function baseState(partial: Partial<JobState>): JobState {
  return {
    id: "x",
    status: "running",
    provider: "fake",
    words: 100,
    spineItemCount: 1,
    chunks: { total: 10, done: 4 },
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, ceilingUsd: 10 },
    ...partial,
  };
}

test("jobMetrics computes eta and throughput from the duration window", () => {
  const state = baseState({
    chunks: { total: 10, done: 4 },
    chunkDurationsMs: [2000, 2000, 2000, 2000], // avg 2s, 6 remaining
  });

  const m = jobMetrics(state);
  expect(m.pct).toBeCloseTo(40);
  expect(m.etaMs).toBe(12_000); // 2s * 6
  expect(m.chunksPerMin).toBe(30); // 60000 / 2000
});

test("jobMetrics returns only pct when there is no timing data (back-compat manifest)", () => {
  const state = baseState({ chunks: { total: 10, done: 4 }, chunkDurationsMs: undefined });
  const m = jobMetrics(state);
  expect(m.pct).toBeCloseTo(40);
  expect(m.etaMs).toBeUndefined();
  expect(m.chunksPerMin).toBeUndefined();
});

test("jobMetrics returns 100% and no eta when complete", () => {
  const state = baseState({ chunks: { total: 10, done: 10 }, chunkDurationsMs: [1000] });
  const m = jobMetrics(state);
  expect(m.pct).toBe(100);
  expect(m.etaMs).toBeUndefined();
});

test("jobMetrics handles a zero-total job without dividing by zero", () => {
  const state = baseState({ chunks: { total: 0, done: 0 }, chunkDurationsMs: [] });
  const m = jobMetrics(state);
  expect(m.pct).toBe(0);
  expect(m.etaMs).toBeUndefined();
});
