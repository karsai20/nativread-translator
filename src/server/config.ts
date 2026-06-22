// Server configuration from the environment (.env is loaded by Bun automatically).
//
// Binding defaults to 0.0.0.0 so the app is reachable when it runs inside its own
// container (e.g. a Proxmox LXC); the port defaults to an uncommon, non-well-known
// value to avoid colliding with other services on the box. Both are overridable.

import { FakeTranslator } from "../core/providers/fake.ts";
import { DeepSeekTranslator } from "../core/providers/deepseek.ts";
import type { Translator } from "../core/translator.ts";

export interface Config {
  host: string;
  port: number;
  jobsDir: string;
  costCeilingUsd: number;
  apiKey: string;
  providerName: "deepseek" | "fake";
}

export function loadConfig(): Config {
  const apiKey = (process.env.PROVIDER_API_KEY ?? "").trim();
  return {
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: Number(process.env.PORT) || 48217,
    jobsDir: process.env.JOBS_DIR?.trim() || "./jobs",
    costCeilingUsd: Number(process.env.COST_CEILING_USD) || 10,
    apiKey,
    providerName: apiKey ? "deepseek" : "fake",
  };
}

/** Build the translator for a job. Falls back to the zero-cost fake when no key is set. */
export function createProvider(config: Config): Translator {
  if (config.apiKey) return new DeepSeekTranslator({ apiKey: config.apiKey });
  return new FakeTranslator();
}
