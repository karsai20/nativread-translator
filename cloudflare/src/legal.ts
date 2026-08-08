import { HttpError } from "./security";
import type { Env } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/iu;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface TermsAcceptanceInput {
  id: string;
  acceptedAt: string;
  locale: string;
  method: "ios-clickwrap";
  statementVersion: string;
}

type LegalEnv = Pick<
  Env,
  "TERMS_VERSION" | "TERMS_EFFECTIVE_AT" | "TERMS_DOCUMENT_URL"
  | "TERMS_SUPERSEDED" | "RIGHTS_ATTESTATION_VERSION"
  | "RIGHTS_ATTESTATION_SUPERSEDED"
>;

/**
 * One published version of the Terms. A version number alone is not enough to
 * record an acceptance: the effective date decides whether a click was valid,
 * and the document URL is the evidence of what was actually agreed to. They
 * travel together so an older release can never be recorded with the current
 * release's date or link.
 */
export interface TermsRelease {
  version: string;
  effectiveAt: string;
  documentUrl: string;
}

/** Reads a `[{version, effectiveAt, documentUrl}]` env var, ignoring anything
 *  malformed — a broken entry must narrow what is accepted, never widen it. */
function supersededReleases(value: unknown): TermsRelease[] {
  if (!Array.isArray(value)) return [];
  const releases: TermsRelease[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { version, effectiveAt, documentUrl } = entry as Record<string, unknown>;
    if (
      typeof version !== "string" || version.length === 0
      || typeof effectiveAt !== "string" || !Number.isFinite(Date.parse(effectiveAt))
      || typeof documentUrl !== "string" || !documentUrl.startsWith("https://")
    ) continue;
    releases.push({ version, effectiveAt, documentUrl });
  }
  return releases;
}

/** Current release first, then the superseded ones still honoured. */
export function termsReleases(env: LegalEnv): TermsRelease[] {
  return [
    {
      version: env.TERMS_VERSION,
      effectiveAt: env.TERMS_EFFECTIVE_AT,
      documentUrl: env.TERMS_DOCUMENT_URL,
    },
    ...supersededReleases(env.TERMS_SUPERSEDED)
      .filter((r) => r.version !== env.TERMS_VERSION),
  ];
}

/** The release a client claims to have accepted, or undefined if not honoured. */
export function termsReleaseFor(
  version: unknown,
  env: LegalEnv,
): TermsRelease | undefined {
  if (typeof version !== "string") return undefined;
  return termsReleases(env).find((r) => r.version === version);
}

/** Every version of a single-string legal constant that is still honoured. */
export function honouredVersions(current: string, superseded: unknown): string[] {
  const extra = Array.isArray(superseded)
    ? superseded.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  return [current, ...extra.filter((v) => v !== current)];
}

export function validateTermsAcceptance(
  value: unknown,
  env: LegalEnv,
  release: TermsRelease,
  now = Date.now(),
): TermsAcceptanceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(403, "A fordítás előtt fogadd el az aktuális felhasználási feltételeket.");
  }
  const input = value as Record<string, unknown>;
  const acceptedAt = typeof input.acceptedAt === "string"
    ? Date.parse(input.acceptedAt)
    : Number.NaN;
  const effectiveAt = Date.parse(release.effectiveAt);
  const valid = typeof input.id === "string"
    && UUID_PATTERN.test(input.id)
    && typeof input.locale === "string"
    && LOCALE_PATTERN.test(input.locale)
    && input.method === "ios-clickwrap"
    && typeof input.statementVersion === "string"
    && honouredVersions(
      env.RIGHTS_ATTESTATION_VERSION, env.RIGHTS_ATTESTATION_SUPERSEDED,
    ).includes(input.statementVersion)
    && Number.isFinite(acceptedAt)
    && Number.isFinite(effectiveAt)
    && acceptedAt >= effectiveAt
    && acceptedAt <= now + MAX_CLOCK_SKEW_MS;
  if (!valid) {
    throw new HttpError(403, "A felhasználási feltételek elfogadása hiányzik vagy már nem érvényes.");
  }
  return {
    id: input.id as string,
    acceptedAt: new Date(acceptedAt).toISOString(),
    locale: input.locale as string,
    method: "ios-clickwrap",
    statementVersion: input.statementVersion as string,
  };
}
