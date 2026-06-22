// Server-side configuration from the environment.
//
// Deploy target is a private Proxmox homelab: a shared household provider key in the
// container env is the default, so a non-technical reader never pastes a key. The fake
// provider runs when no key is present (zero-cost dry run). JOBS_DIR / LIBRARY_DIR point
// at persistent Proxmox volumes.

import { DeepSeekTranslator } from "@/lib/core/providers/deepseek";
import { FakeTranslator } from "@/lib/core/providers/fake";
import type { Translator } from "@/lib/core/translator";

export interface ServerConfig {
  jobsDir: string;
  libraryDir: string;
  costCeilingUsd: number;
  apiKey: string;
  providerName: "deepseek" | "fake";
  refine: boolean;
}

export function loadConfig(): ServerConfig {
  const apiKey = (process.env.PROVIDER_API_KEY ?? "").trim();
  return {
    jobsDir: process.env.JOBS_DIR?.trim() || "jobs",
    libraryDir: process.env.LIBRARY_DIR?.trim() || "library",
    costCeilingUsd: Number(process.env.COST_CEILING_USD) || 10,
    apiKey,
    providerName: apiKey ? "deepseek" : "fake",
    // Second polish pass is on by default (quality is the priority; DeepSeek is cheap).
    refine: (process.env.TRANSLATION_REFINE ?? "1") !== "0",
  };
}

export function createProvider(config: ServerConfig): Translator {
  return config.apiKey ? new DeepSeekTranslator({ apiKey: config.apiKey }) : new FakeTranslator();
}
