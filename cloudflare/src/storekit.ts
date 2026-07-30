import { SignJWT, decodeJwt, importPKCS8 } from "jose";

import { HttpError } from "./security";
import type { Env } from "./types";

const PRODUCTION_HOST = "https://api.storekit.itunes.apple.com";
const SANDBOX_HOST = "https://api.storekit-sandbox.itunes.apple.com";
const AUDIENCE = "appstoreconnect-v1";
const TOKEN_TTL_SECONDS = 20 * 60;

type Fetcher = typeof fetch;

export interface AppStoreTransaction {
  transactionId: string;
  productId: string;
  bundleId: string;
  type: string;
  appAccountToken?: string;
  environment: "Production" | "Sandbox";
  revoked: boolean;
}

export interface PurchaseExpectation {
  bundleId: string;
  productId: string;
  appAccountToken: string;
  /** Sandbox purchases are free, so a paying deployment must refuse them. */
  requireProduction: boolean;
}

/** The reason a verified transaction may not be spent here, or undefined when it may. */
export function transactionRejection(
  transaction: AppStoreTransaction,
  expected: PurchaseExpectation,
): string | undefined {
  if (expected.requireProduction && transaction.environment !== "Production") return "environment";
  if (transaction.bundleId !== expected.bundleId) return "bundle";
  if (transaction.type !== "Consumable") return "type";
  if (transaction.revoked) return "revoked";
  if (transaction.appAccountToken !== expected.appAccountToken) return "account";
  if (transaction.productId !== expected.productId) return "tier";
  return undefined;
}

interface AppStoreCredentials {
  issuerId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
}

function normalizedPrivateKey(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

export function appStoreCredentials(env: Env): AppStoreCredentials {
  const credentials = {
    issuerId: env.APP_STORE_ISSUER_ID,
    keyId: env.APP_STORE_KEY_ID,
    privateKey: env.APP_STORE_PRIVATE_KEY,
    bundleId: env.APP_STORE_BUNDLE_ID,
  };
  if (Object.values(credentials).some((value) => !value)) {
    throw new HttpError(503, "A vásárlás ellenőrzése nincs beállítva.");
  }
  return credentials;
}

/** Short-lived App Store Connect API token, signed with the In-App Purchase key. */
async function apiToken(credentials: AppStoreCredentials): Promise<string> {
  const key = await importPKCS8(normalizedPrivateKey(credentials.privateKey), "ES256");
  return new SignJWT({ bid: credentials.bundleId })
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
    .setIssuer(credentials.issuerId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

/**
 * Asks Apple what a transaction id really is.
 *
 * The response body is a JWS, but it arrives over TLS from an endpoint that
 * authenticated us — that is what makes the payload trustworthy, so the x5c
 * certificate chain does not have to be validated locally. A sandbox purchase is
 * unknown to the production host, so a 404 there is retried against sandbox.
 *
 * Reaching sandbox is not the same as trusting it: the environment is reported
 * back in `environment`, and the caller decides whether a free sandbox purchase
 * may be spent on this deployment.
 */
export async function appStoreTransaction(
  transactionId: string,
  env: Env,
  fetcher: Fetcher = fetch,
): Promise<AppStoreTransaction> {
  const credentials = appStoreCredentials(env);
  const token = await apiToken(credentials);

  let response: Response | undefined;
  for (const host of [PRODUCTION_HOST, SANDBOX_HOST]) {
    response = await fetcher(`${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (response.status !== 404) break;
  }
  if (!response || response.status === 404) {
    throw new HttpError(400, "Az App Store nem ismeri ezt a tranzakciót.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(503, "A vásárlás ellenőrzése nincs beállítva.");
  }
  if (!response.ok) {
    throw new HttpError(502, "Az App Store ellenőrzés most nem érhető el.");
  }

  const body = (await response.json()) as { signedTransactionInfo?: unknown };
  if (typeof body.signedTransactionInfo !== "string") {
    throw new HttpError(502, "Az App Store válasza hiányos volt.");
  }
  const payload = decodeJwt(body.signedTransactionInfo) as Record<string, unknown>;
  const environment = payload.environment === "Sandbox" ? "Sandbox" : "Production";
  return {
    transactionId: String(payload.transactionId ?? ""),
    productId: String(payload.productId ?? ""),
    bundleId: String(payload.bundleId ?? ""),
    type: String(payload.type ?? ""),
    appAccountToken: typeof payload.appAccountToken === "string"
      ? payload.appAccountToken.toLowerCase()
      : undefined,
    environment,
    revoked: payload.revocationDate !== undefined && payload.revocationDate !== null,
  };
}
