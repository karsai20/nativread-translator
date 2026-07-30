// Server-side configuration from the environment.
//
// Deploy target is a private Proxmox homelab: a shared household provider key in the
// container env is the default, so a non-technical reader never pastes a key. The fake
// provider runs when no key is present (zero-cost dry run). JOBS_DIR / LIBRARY_DIR point
// at persistent Proxmox volumes.

import { DeepSeekTranslator } from "@/lib/core/providers/deepseek";
import { FakeTranslator } from "@/lib/core/providers/fake";
import { OpenAICompatibleTranslator } from "@/lib/core/providers/openai-compatible";
import { DEFAULT_EPUB_ARCHIVE_LIMITS } from "@/lib/core/epub";
import type { Translator } from "@/lib/core/translator";
import type { PrecisionMode } from "@/lib/core/quality/route";

export type ProviderName = "fake" | "openai" | "gemini" | "deepseek";

const PUBLIC_ARTIFACT_RETENTION_HOURS = 24;
const MAX_PUBLIC_ARTIFACT_RETENTION_HOURS = 30 * 24;

export interface ServerConfig {
  jobsDir: string;
  libraryDir: string;
  entitlementsDir: string;
  costCeilingUsd: number;
  apiKey: string;
  providerName: ProviderName;
  model?: string;
  baseUrl?: string;
  reasonerModel?: string;
  /** Thinking configuration for the draft/refine/judge calls; see thinkingFor(). */
  reasoningEffort?: string;
  thinkingBody?: Record<string, unknown>;
  refine: boolean;
  refineSelective: boolean;
  reasonerForHard: boolean;
  precision: PrecisionMode;
  concurrency: number;
  maxEpubUploadBytes: number;
  maxEpubEntries: number;
  maxEpubUncompressedBytes: number;
  mobileSharedSecret?: string;
  /**
   * Whether the unauthenticated dev / LAN path (client-supplied user id header,
   * no login and no shared secret) may serve requests. Off in production unless
   * explicitly opted into, so a missing auth config fails closed instead of
   * quietly opening every route.
   */
  allowDevAuth: boolean;
  /** Sign in with Apple client/bundle ids accepted as id-token `aud`. */
  appleClientIds?: string[];
  /** Server credentials used only to revoke Apple authorization on deletion. */
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  /** Google OAuth client ids accepted as id-token `aud`. */
  googleClientIds?: string[];
  /** HMAC secret for the backend session minted after Sign in with Apple. */
  sessionSecret?: string;
  /** Public-mode lifetime for source/result artifacts; 0 disables the sweep. */
  artifactRetentionHours: number;
  requireFullTranslationEntitlements: boolean;
  allowUnsignedStoreKitGrants: boolean;
}

/** Comma-separated env var → trimmed non-empty list, or undefined. */
function csvEnv(name: string): string[] | undefined {
  const list = (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function providerFromEnv(raw: string): ProviderName | undefined {
  if (raw === "fake" || raw === "openai" || raw === "gemini" || raw === "deepseek") return raw;
  return undefined;
}

function inferProvider(): ProviderName {
  const explicit = providerFromEnv((process.env.TRANSLATION_PROVIDER ?? "").trim().toLowerCase());
  if (explicit) return explicit;
  if ((process.env.OPENAI_API_KEY ?? process.env.PROVIDER_API_KEY ?? "").trim()) return "openai";
  if ((process.env.GEMINI_API_KEY ?? "").trim()) return "gemini";
  if ((process.env.DEEPSEEK_API_KEY ?? "").trim()) return "deepseek";
  return "fake";
}

function providerApiKey(provider: ProviderName): string {
  if (provider === "openai") return (process.env.OPENAI_API_KEY ?? process.env.PROVIDER_API_KEY ?? "").trim();
  if (provider === "gemini") return (process.env.GEMINI_API_KEY ?? process.env.PROVIDER_API_KEY ?? "").trim();
  if (provider === "deepseek") return (process.env.DEEPSEEK_API_KEY ?? process.env.PROVIDER_API_KEY ?? "").trim();
  return "";
}

function providerModel(provider: ProviderName): string | undefined {
  const generic = process.env.PROVIDER_MODEL?.trim();
  if (generic) return generic;
  if (provider === "openai") return process.env.OPENAI_MODEL?.trim() || undefined;
  if (provider === "gemini") return process.env.GEMINI_MODEL?.trim() || undefined;
  if (provider === "deepseek") return process.env.DEEPSEEK_MODEL?.trim() || undefined;
  return undefined;
}

function providerBaseUrl(provider: ProviderName): string | undefined {
  const generic = process.env.PROVIDER_BASE_URL?.trim();
  if (generic) return generic;
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  return undefined;
}

/** Lowest thinking setting available across the Gemini families. */
const DEFAULT_THINKING = "minimal";

/**
 * Gemini models think by default and bill thought tokens at the OUTPUT rate, which
 * silently inflates every draft, refine and judge call — measured on gemini-3.6-flash,
 * translating one sentence spent 731 thinking tokens against 16 tokens of answer.
 * Translation is not a reasoning task; the pipeline escalates genuinely hard chunks to
 * PROVIDER_REASONER_MODEL instead, and that call keeps its thinking.
 *
 * The two families take different parameters (verified with `bun run eval:probe`):
 * 2.5 accepts OpenAI's `reasoning_effort` and rejects Gemini's thinking_config, while 3.x
 * rejects `reasoning_effort: none` outright and wants thinking_level nested under a
 * top-level `extra_body` key. Set PROVIDER_THINKING=default to send neither.
 */
function thinkingFor(
  provider: ProviderName,
  model: string | undefined,
): { reasoningEffort?: string; thinkingBody?: Record<string, unknown> } {
  if (provider !== "gemini") return {};
  const level = (process.env.PROVIDER_THINKING ?? DEFAULT_THINKING).trim();
  if (!level || level === "default") return {};

  if (/^gemini-3/.test(model ?? "")) {
    return { thinkingBody: { extra_body: { google: { thinking_config: { thinking_level: level } } } } };
  }
  return { reasoningEffort: level === DEFAULT_THINKING ? "none" : level };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function loadConfig(): ServerConfig {
  const providerName = inferProvider();
  const apiKey = providerApiKey(providerName);
  const appleClientIds = csvEnv("APPLE_CLIENT_IDS");
  const googleClientIds = csvEnv("GOOGLE_CLIENT_IDS");
  const publicMode = Boolean(appleClientIds?.length || googleClientIds?.length);
  const configuredRetention = Number(process.env.ARTIFACT_RETENTION_HOURS);
  const artifactRetentionHours = publicMode
    ? Math.min(
        Number.isFinite(configuredRetention) && configuredRetention > 0
          ? configuredRetention
          : PUBLIC_ARTIFACT_RETENTION_HOURS,
        MAX_PUBLIC_ARTIFACT_RETENTION_HOURS,
      )
    : Number.isFinite(configuredRetention) && configuredRetention >= 0
      ? configuredRetention
      : 0;
  const rawPrecision = (process.env.TRANSLATION_PRECISION ?? "balanced").trim();
  const precision: PrecisionMode =
    rawPrecision === "fidelity" || rawPrecision === "natural" ? rawPrecision : "balanced";
  return {
    jobsDir: process.env.JOBS_DIR?.trim() || "jobs",
    libraryDir: process.env.LIBRARY_DIR?.trim() || "library",
    entitlementsDir: process.env.ENTITLEMENTS_DIR?.trim() || "entitlements",
    costCeilingUsd: Number(process.env.COST_CEILING_USD) || 10,
    apiKey,
    providerName,
    model: providerModel(providerName),
    baseUrl: providerBaseUrl(providerName),
    reasonerModel: process.env.PROVIDER_REASONER_MODEL?.trim() || undefined,
    ...thinkingFor(providerName, providerModel(providerName)),
    // Second polish pass is on by default (quality is the priority).
    refine: (process.env.TRANSLATION_REFINE ?? "1") !== "0",
    // Gate that polish on a cheap quality estimate by default: only weak drafts pay for
    // the full second pass. Set TRANSLATION_REFINE_SELECTIVE=0 to refine every chunk.
    refineSelective: (process.env.TRANSLATION_REFINE_SELECTIVE ?? "1") !== "0",
    // Escalate the weakest chunks to a configured reasoning model for refine.
    reasonerForHard: (process.env.TRANSLATION_REASONER_HARD ?? "1") !== "0",
    precision,
    // Chapters translated in parallel. Clamped to a sane range to avoid rate-limit storms.
    concurrency: Math.min(8, Math.max(1, Number(process.env.TRANSLATION_CONCURRENCY) || 4)),
    maxEpubUploadBytes: positiveIntegerEnv(
      "MAX_EPUB_UPLOAD_BYTES",
      DEFAULT_EPUB_ARCHIVE_LIMITS.maxArchiveBytes,
    ),
    maxEpubEntries: positiveIntegerEnv(
      "MAX_EPUB_ENTRIES",
      DEFAULT_EPUB_ARCHIVE_LIMITS.maxEntries,
    ),
    maxEpubUncompressedBytes: positiveIntegerEnv(
      "MAX_EPUB_UNCOMPRESSED_BYTES",
      DEFAULT_EPUB_ARCHIVE_LIMITS.maxUncompressedBytes,
    ),
    mobileSharedSecret: process.env.NATIVREAD_BACKEND_SHARED_SECRET?.trim() || undefined,
    allowDevAuth: process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_AUTH === "1",
    appleClientIds,
    appleTeamId: process.env.APPLE_TEAM_ID?.trim() || undefined,
    appleKeyId: process.env.APPLE_KEY_ID?.trim() || undefined,
    applePrivateKey: process.env.APPLE_PRIVATE_KEY?.trim() || undefined,
    googleClientIds,
    sessionSecret: process.env.NATIVREAD_SESSION_SECRET?.trim() || undefined,
    artifactRetentionHours,
    requireFullTranslationEntitlements: (process.env.REQUIRE_TRANSLATION_ENTITLEMENTS ?? "0") === "1",
    allowUnsignedStoreKitGrants: (process.env.STOREKIT_ALLOW_UNSIGNED_GRANTS ?? "0") === "1",
  };
}

export function createProvider(config: ServerConfig): Translator {
  if (config.providerName === "fake") return new FakeTranslator();
  if (!config.apiKey) throw new Error(`Missing API key for provider ${config.providerName}.`);

  if (config.providerName === "deepseek") {
    return new DeepSeekTranslator({
      apiKey: config.apiKey,
      ...(config.model ? { model: config.model } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
  }

  if (!config.model) {
    throw new Error(`Missing PROVIDER_MODEL for provider ${config.providerName}.`);
  }
  return new OpenAICompatibleTranslator({
    name: config.providerName,
    apiKey: config.apiKey,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.reasonerModel ? { reasonerModel: config.reasonerModel } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.thinkingBody ? { thinkingBody: config.thinkingBody } : {}),
  });
}
