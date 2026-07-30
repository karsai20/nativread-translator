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
  "TERMS_EFFECTIVE_AT" | "RIGHTS_ATTESTATION_VERSION"
>;

export function validateTermsAcceptance(
  value: unknown,
  env: LegalEnv,
  now = Date.now(),
): TermsAcceptanceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(403, "A fordítás előtt fogadd el az aktuális felhasználási feltételeket.");
  }
  const input = value as Record<string, unknown>;
  const acceptedAt = typeof input.acceptedAt === "string"
    ? Date.parse(input.acceptedAt)
    : Number.NaN;
  const effectiveAt = Date.parse(env.TERMS_EFFECTIVE_AT);
  const valid = typeof input.id === "string"
    && UUID_PATTERN.test(input.id)
    && typeof input.locale === "string"
    && LOCALE_PATTERN.test(input.locale)
    && input.method === "ios-clickwrap"
    && input.statementVersion === env.RIGHTS_ATTESTATION_VERSION
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
