// Derived progress metrics for a job. ETA and throughput are computed from the recent
// chunk-duration window (not stored), so they adapt as the provider speeds up or slows.

import type { JobState } from "./job";

export interface JobMetrics {
  /** Completion percentage, 0–100. */
  pct: number;
  /** Estimated time remaining in ms, when there is timing data and work left. */
  etaMs?: number;
  /** Recent throughput in chunks per minute. */
  chunksPerMin?: number;
}

export function jobMetrics(state: JobState): JobMetrics {
  const { total, done } = state.chunks;
  const remaining = Math.max(0, total - done);
  const pct = total > 0 ? (done / total) * 100 : 0;

  const durations = state.chunkDurationsMs ?? [];
  if (durations.length === 0 || remaining <= 0) return { pct };

  const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  if (avgMs <= 0) return { pct };

  return { pct, etaMs: avgMs * remaining, chunksPerMin: 60_000 / avgMs };
}
