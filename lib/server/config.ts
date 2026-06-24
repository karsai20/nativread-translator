// Server-side configuration from the environment.
//
// Deploy target is a private Proxmox homelab: a shared household provider key in the
// container env is the default, so a non-technical reader never pastes a key. The fake
// provider runs when no key is present (zero-cost dry run). JOBS_DIR / LIBRARY_DIR point
// at persistent Proxmox volumes.

import { DeepSeekTranslator } from "@/lib/core/providers/deepseek";
import { FakeTranslator } from "@/lib/core/providers/fake";
import type { Translator } from "@/lib/core/translator";
import type { PrecisionMode } from "@/lib/core/quality/route";

export interface ServerConfig {
  jobsDir: string;
  libraryDir: string;
  costCeilingUsd: number;
  apiKey: string;
  providerName: "deepseek" | "fake";
  refine: boolean;
  refineSelective: boolean;
  reasonerForHard: boolean;
  precision: PrecisionMode;
  concurrency: number;
}

export function loadConfig(): ServerConfig {
  const apiKey = (process.env.PROVIDER_API_KEY ?? "").trim();
  const rawPrecision = (process.env.TRANSLATION_PRECISION ?? "balanced").trim();
  const precision: PrecisionMode =
    rawPrecision === "fidelity" || rawPrecision === "natural" ? rawPrecision : "balanced";
  return {
    jobsDir: process.env.JOBS_DIR?.trim() || "jobs",
    libraryDir: process.env.LIBRARY_DIR?.trim() || "library",
    costCeilingUsd: Number(process.env.COST_CEILING_USD) || 10,
    apiKey,
    providerName: apiKey ? "deepseek" : "fake",
    // Second polish pass is on by default (quality is the priority; DeepSeek is cheap).
    refine: (process.env.TRANSLATION_REFINE ?? "1") !== "0",
    // Gate that polish on a cheap quality estimate by default: only weak drafts pay for
    // the full second pass. Set TRANSLATION_REFINE_SELECTIVE=0 to refine every chunk.
    refineSelective: (process.env.TRANSLATION_REFINE_SELECTIVE ?? "1") !== "0",
    // Escalate the weakest chunks to the reasoning model (deepseek-reasoner) for refine.
    reasonerForHard: (process.env.TRANSLATION_REASONER_HARD ?? "1") !== "0",
    precision,
    // Chapters translated in parallel. Clamped to a sane range to avoid rate-limit storms.
    concurrency: Math.min(8, Math.max(1, Number(process.env.TRANSLATION_CONCURRENCY) || 4)),
  };
}

export function createProvider(config: ServerConfig): Translator {
  return config.apiKey ? new DeepSeekTranslator({ apiKey: config.apiKey }) : new FakeTranslator();
}
