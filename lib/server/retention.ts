import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getLibraryEntry } from "@/lib/core/library";
import { deleteJob, isRunning, jobDirFor } from "./jobs";
import type { ServerConfig } from "./config";
import { readManifest } from "@/lib/core/job";

const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
let sweepStarted = false;

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Remove public-backend book artifacts that outlive the configured retry window. */
export function pruneExpiredArtifacts(config: ServerConfig, now = Date.now()): number {
  if (config.artifactRetentionHours <= 0) return 0;
  const cutoff = now - config.artifactRetentionHours * 60 * 60 * 1_000;
  let removed = 0;

  if (existsSync(config.jobsDir)) {
    for (const entry of readdirSync(config.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || isRunning(entry.name)) continue;
      const dir = jobDirFor(config, entry.name);
      const manifest = readManifest(dir);
      const touched = timestamp(manifest?.updatedAt)
        ?? timestamp(manifest?.finishedAt)
        ?? timestamp(manifest?.createdAt)
        ?? statSync(dir).mtimeMs;
      if (touched < cutoff) {
        deleteJob(config, entry.name, true);
        removed += 1;
      }
    }
  }

  // A library directory may survive a legacy/manual job deletion. Scan the
  // directories themselves (not only valid metadata rows), so a missing or
  // corrupt meta.json cannot make a translated EPUB an immortal orphan.
  if (existsSync(config.libraryDir)) {
    for (const entry of readdirSync(config.libraryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(config.libraryDir, entry.name);
      const metadata = getLibraryEntry(config.libraryDir, entry.name);
      const touched = timestamp(metadata?.createdAt) ?? statSync(dir).mtimeMs;
      if (touched < cutoff) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    }
  }

  return removed;
}

/** Start one unref'd hourly sweep in the long-running Node/Docker process. */
export function ensureRetentionSweep(config: ServerConfig): void {
  if (sweepStarted || config.artifactRetentionHours <= 0) return;
  sweepStarted = true;
  pruneExpiredArtifacts(config);
  const timer = setInterval(() => pruneExpiredArtifacts(config), SWEEP_INTERVAL_MS);
  timer.unref();
}
