import { SignJWT, importPKCS8 } from "jose";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

export interface AppleOAuthCredentials {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}

type Fetcher = typeof fetch;

function normalizedPrivateKey(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

async function clientSecret(credentials: AppleOAuthCredentials): Promise<string> {
  const key = await importPKCS8(normalizedPrivateKey(credentials.privateKey), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
    .setIssuer(credentials.teamId)
    .setAudience(APPLE_ISSUER)
    .setSubject(credentials.clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

async function appleFormRequest(
  url: string,
  fields: Record<string, string>,
  fetcher: Fetcher,
): Promise<Response> {
  return fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(fields),
    cache: "no-store",
  });
}

/**
 * Exchanges a fresh, one-time authorization code and immediately revokes the
 * resulting Apple refresh token. The account route performs this before
 * deleting data, so a failed revocation never produces a false success.
 */
export async function revokeAppleAuthorizationCode(
  authorizationCode: string,
  credentials: AppleOAuthCredentials,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const secret = await clientSecret(credentials);
  const exchange = await appleFormRequest(
    APPLE_TOKEN_URL,
    {
      client_id: credentials.clientId,
      client_secret: secret,
      code: authorizationCode,
      grant_type: "authorization_code",
    },
    fetcher,
  );
  if (!exchange.ok) {
    throw new Error(`Apple authorization exchange failed (${exchange.status}).`);
  }
  const token = (await exchange.json()) as { refresh_token?: unknown };
  if (typeof token.refresh_token !== "string" || !token.refresh_token) {
    throw new Error("Apple authorization exchange returned no refresh token.");
  }

  const revoked = await appleFormRequest(
    APPLE_REVOKE_URL,
    {
      client_id: credentials.clientId,
      client_secret: secret,
      token: token.refresh_token,
      token_type_hint: "refresh_token",
    },
    fetcher,
  );
  if (!revoked.ok) {
    throw new Error(`Apple token revocation failed (${revoked.status}).`);
  }
}
