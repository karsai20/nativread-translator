// In-memory job registry that survives across requests within the Next.js server
// process, backed by on-disk job state (so /status works and resume is possible).

import { join } from "node:path";
import { readFileSync } from "node:fs";

import { runJob, readManifest, type JobState } from "@/lib/core/job";
import { createProvider, type ServerConfig } from "./config";

const states = new Map<string, JobState>();
const running = new Set<string>();

export function jobDirFor(config: ServerConfig, id: string): string {
  return join(config.jobsDir, id);
}

export function cacheState(state: JobState): void {
  states.set(state.id, state);
}

export function getState(config: ServerConfig, id: string): JobState | undefined {
  return states.get(id) ?? readManifest(jobDirFor(config, id));
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

/** Start (or resume) a translation job in the background. Idempotent while running. */
export function startJob(config: ServerConfig, id: string): void {
  if (running.has(id)) return;

  const jobDir = jobDirFor(config, id);
  const epubBytes = new Uint8Array(readFileSync(join(jobDir, "source.epub")));
  const provider = createProvider(config);

  running.add(id);
  void runJob({
    id,
    epubBytes,
    provider,
    jobDir,
    ceilingUsd: config.costCeilingUsd,
    refine: config.refine,
    libraryDir: config.libraryDir,
    onProgress: cacheState,
  })
    .catch((err) => {
      console.error(`[job ${id}] failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => running.delete(id));
}
