// OIDC id-token verification for the public backend.
//
// Phase 1a trust boundary (see ../nativread/docs/translator-plan.md T1/T2): the
// client's identity must come from a token the provider signed, never from a
// header the client can set. We verify Sign in with Apple and Google id-tokens
// against each provider's JWKS and derive a stable, provider-namespaced userId
// (`apple:<sub>` / `google:<sub>`). Apple and Google are separate accounts in
// Phase 1, so the namespace prefix keeps them from ever colliding.

import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

export interface OidcProvider {
  /** "apple" | "google" — also the userId namespace prefix. */
  name: string;
  /** Acceptable `iss` values (Google emits two forms). */
  issuers: string[];
  /** Acceptable `aud` values (the app's client / bundle ids). */
  audiences: string[];
  /** Key resolver: remote JWKS in prod, a local set in tests. */
  jwks: JWTVerifyGetKey;
}

export interface VerifiedIdentity {
  userId: string;
  provider: string;
  audience: string;
}

const APPLE = {
  issuers: ["https://appleid.apple.com"],
  jwksUrl: "https://appleid.apple.com/auth/keys",
} as const;

const GOOGLE = {
  // Google issues id-tokens with either the bare or the https issuer form.
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
} as const;

// Remote JWKS resolvers are cached per process: jose caches the fetched keys
// inside a resolver, so re-creating one on every request would drop that cache
// and refetch. One resolver per provider, reused across requests.
let appleJwks: JWTVerifyGetKey | undefined;
let googleJwks: JWTVerifyGetKey | undefined;

export interface OidcClientConfig {
  appleClientIds?: string[];
  googleClientIds?: string[];
}

/**
 * Builds the provider list from configured client ids. Returns `[]` when no
 * provider is configured — the caller reads that as "login not configured"
 * (dev / LAN mode) rather than "reject everything".
 */
export function oidcProvidersFromConfig(config: OidcClientConfig): OidcProvider[] {
  const providers: OidcProvider[] = [];
  if (config.appleClientIds?.length) {
    appleJwks ??= createRemoteJWKSet(new URL(APPLE.jwksUrl));
    providers.push({
      name: "apple",
      issuers: [...APPLE.issuers],
      audiences: config.appleClientIds,
      jwks: appleJwks,
    });
  }
  if (config.googleClientIds?.length) {
    googleJwks ??= createRemoteJWKSet(new URL(GOOGLE.jwksUrl));
    providers.push({
      name: "google",
      issuers: [...GOOGLE.issuers],
      audiences: config.googleClientIds,
      jwks: googleJwks,
    });
  }
  return providers;
}

/**
 * Verifies an OIDC id-token against the configured providers and returns a
 * provider-namespaced userId, or `null` if no provider accepts it.
 *
 * Each provider's `jwtVerify` checks the signature against that provider's
 * JWKS and enforces `iss`, `aud`, and `exp`. We try providers in turn and take
 * the first that accepts the token — no unverified claim is ever trusted to
 * route the token, so a forged `iss` can't steer verification.
 */
export async function verifyIdToken(
  token: string,
  providers: OidcProvider[],
): Promise<VerifiedIdentity | null> {
  for (const provider of providers) {
    try {
      const { payload } = await jwtVerify(token, provider.jwks, {
        issuer: provider.issuers,
        audience: provider.audiences,
        // Pin the signature algorithm: both Apple and Google id-tokens are
        // RS256. Explicit rejection of anything else (none / HS* alg-confusion)
        // rather than relying on the key type to imply it.
        algorithms: ["RS256"],
      });
      if (typeof payload.sub === "string" && payload.sub.length > 0) {
        const audience = typeof payload.aud === "string"
          ? payload.aud
          : payload.aud?.find((value) => provider.audiences.includes(value));
        if (!audience) continue;
        return {
          userId: `${provider.name}:${payload.sub}`,
          provider: provider.name,
          audience,
        };
      }
    } catch {
      // Wrong signature / issuer / audience / expiry for this provider; the
      // token may still belong to another configured provider — try the next.
    }
  }
  return null;
}
