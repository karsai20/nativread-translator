// In-memory job registry that survives across requests within the Next.js server
// process, backed by on-disk job state (so /status works and resume is possible).

import { join } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";

import { runJob, readManifest, type JobState } from "@/lib/core/job";
import { createProvider, type ServerConfig } from "./config";

/** A job plus whether it is actively running in THIS process right now. */
export type JobSummary = JobState & { running: boolean };

const states = new Map<string, JobState>();
const running = new Set<string>();
// Per-job abort controllers, so a running job can be terminated (stop = resumable,
// discard = stop + delete). Only populated while a job runs in this process.
const controllers = new Map<string, AbortController>();

// Job ids are always crypto.randomUUID(). Validating against that shape before using an id
// in a filesystem path keeps a hostile id (e.g. "../../etc") from escaping the jobs dir —
// critical for discard, which deletes a directory.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

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

  const controller = new AbortController();
  controllers.set(id, controller);
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
    signal: controller.signal,
  })
    .catch((err) => {
      // Pass id/message as args (not interpolated into the format string) so a log message
      // can't be forged via an injected format specifier.
      console.error("[job %s] failed: %s", id, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      running.delete(id);
      controllers.delete(id);
    });
}

/**
 * Stop a running job at the next chunk boundary, aborting any in-flight provider request.
 * Resumable: finished chunks stay on disk, so `startJob` later continues from there.
 * Returns true if a running job was signalled.
 */
export function stopJob(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Discard a job entirely: stop it if running, then delete its on-disk directory. */
export function discardJob(config: ServerConfig, id: string): void {
  stopJob(id);
  states.delete(id);
  rmSync(jobDirFor(config, id), { recursive: true, force: true });
}

/**
 * Active jobs for the admin panel: every on-disk job that is NOT finished ("done" jobs live
 * in the household library). Each is tagged with whether it is running in this process now.
 * Newest first (by manifest mtime).
 */
export function listJobs(config: ServerConfig): JobSummary[] {
  if (!existsSync(config.jobsDir)) return [];
  const summaries: { summary: JobSummary; mtimeMs: number }[] = [];
  for (const id of readdirSync(config.jobsDir)) {
    const jobDir = jobDirFor(config, id);
    const state = states.get(id) ?? readManifest(jobDir);
    if (!state || state.status === "done") continue;
    const manifest = join(jobDir, "manifest.json");
    const mtimeMs = existsSync(manifest) ? statSync(manifest).mtimeMs : 0;
    summaries.push({ summary: { ...state, running: running.has(id) }, mtimeMs });
  }
  return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs).map((s) => s.summary);
}
