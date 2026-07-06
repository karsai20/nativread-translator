// In-memory job registry that survives across requests within the Next.js server
// process, backed by on-disk job state (so /status works and resume is possible).

import { join } from "node:path";
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";

import { runJob, readManifest, setManifestStatus, type JobState } from "@/lib/core/job";
import type { PrecisionMode } from "@/lib/core/quality/route";
import { createProvider, type ServerConfig } from "./config";

type ControlSignal = "pause" | "cancel";

const states = new Map<string, JobState>();
const running = new Set<string>();
const controls = new Map<string, ControlSignal>();

/** Fraction of a book translated in "sample" (preview) mode. */
export const SAMPLE_FRACTION = 0.01;

// Job ids are opaque UUIDs (crypto.randomUUID at upload). Anything else is rejected
// before it can reach a filesystem path — a malicious id like "../../etc" must never
// escape jobsDir/libraryDir, especially for the destructive rmSync in deleteJob.
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

export function jobDirFor(config: ServerConfig, id: string): string {
  if (!isValidJobId(id)) throw new Error(`Invalid job id: ${id}`);
  return join(config.jobsDir, id);
}

export function cacheState(state: JobState): void {
  states.set(state.id, state);
}

export function getState(config: ServerConfig, id: string): JobState | undefined {
  return states.get(id) ?? readManifest(jobDirFor(config, id));
}

/**
 * Ownership predicate: may `userId` act on this job? Fail-closed — a missing
 * job (`undefined`) OR a job with no recorded owner is owned by nobody, so it
 * is never accessible. Every job created through `/api/upload` stores an owner
 * (`ctx.userId`, at least `"local"` in dev), so an ownerless manifest can only
 * be a stray/legacy artifact and must not be world-readable in a public
 * deployment. Callers map a `false` result to a 404 so existence isn't leaked.
 */
export function ownsJob(state: JobState | undefined, userId: string): boolean {
  return Boolean(state?.userId) && state?.userId === userId;
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

/** Every job on disk, freshest state first (in-memory wins over the last flush). */
export function listJobs(config: ServerConfig): JobState[] {
  if (!existsSync(config.jobsDir)) return [];
  return readdirSync(config.jobsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => states.get(e.name) ?? readManifest(jobDirFor(config, e.name)))
    .filter((s): s is JobState => Boolean(s))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function isPrecisionMode(value: unknown): value is PrecisionMode {
  return value === "balanced" || value === "fidelity" || value === "natural";
}

/** Start (or resume) a translation job in the background. Idempotent while running. */
export function startJob(
  config: ServerConfig,
  id: string,
  opts: { sample?: boolean; precision?: PrecisionMode } = {},
): void {
  if (running.has(id)) return;

  controls.delete(id); // a fresh start/resume clears any stale signal
  const jobDir = jobDirFor(config, id);
  const epubBytes = new Uint8Array(readFileSync(join(jobDir, "source.epub")));
  const provider = createProvider(config);

  // Honor a sample request, and keep a previously-started sample a sample on resume (the
  // resume route doesn't re-send the flag) so it never silently expands to the whole book.
  const prior = readManifest(jobDir);
  const sample = opts.sample || Boolean(prior?.sample);
  const precision = isPrecisionMode(opts.precision)
    ? opts.precision
    : isPrecisionMode(prior?.precision)
      ? prior.precision
      : config.precision;

  running.add(id);
  void runJob({
    id,
    epubBytes,
    provider,
    jobDir,
    ceilingUsd: config.costCeilingUsd,
    refine: config.refine,
    selectiveRefine: config.refineSelective,
    reasonerForHard: config.reasonerForHard,
    precision,
    concurrency: config.concurrency,
    libraryDir: config.libraryDir,
    ...(sample ? { sampleFraction: SAMPLE_FRACTION } : {}),
    onProgress: cacheState,
    shouldStop: () => controls.get(id), // peek; cleared in finally
  })
    .catch((err) => {
      console.error(`[job ${id}] failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      running.delete(id);
      controls.delete(id);
    });
}

/**
 * Request a cooperative pause. Returns true if a running loop will pick it up; if the
 * job is idle on disk, its manifest is flipped to paused directly.
 */
export function pauseJob(config: ServerConfig, id: string): JobState | undefined {
  if (running.has(id)) {
    controls.set(id, "pause");
    return getState(config, id);
  }
  const next = setManifestStatus(jobDirFor(config, id), "paused");
  if (next) cacheState(next);
  return next;
}

/** Request cancellation. A running loop ends at its next chunk; idle jobs flip on disk. */
export function cancelJob(config: ServerConfig, id: string): JobState | undefined {
  if (running.has(id)) {
    controls.set(id, "cancel");
    return getState(config, id);
  }
  const next = setManifestStatus(jobDirFor(config, id), "cancelled");
  if (next) cacheState(next);
  return next;
}

/** Stop the job and remove it from disk and memory. Optionally drop its library copy. */
export function deleteJob(config: ServerConfig, id: string, withLibrary = false): void {
  if (!isValidJobId(id)) throw new Error(`Invalid job id: ${id}`);
  if (running.has(id)) controls.set(id, "cancel");
  states.delete(id);
  controls.delete(id);
  rmSync(jobDirFor(config, id), { recursive: true, force: true });
  if (withLibrary) rmSync(join(config.libraryDir, id), { recursive: true, force: true });
}
