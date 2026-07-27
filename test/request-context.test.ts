import { test, expect } from "bun:test";
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWK,
} from "jose";

import { verifyIdToken, type OidcProvider } from "../lib/server/oidc.ts";
import { requestContext } from "../lib/server/request-context.ts";
import { createSessionToken } from "../lib/server/session.ts";

const APPLE_ISS = "https://appleid.apple.com";
const APPLE_AUD = "com.karsai.nativread";
const GOOGLE_ISS = "https://accounts.google.com";
const GOOGLE_AUD = "123-abc.apps.googleusercontent.com";

interface Fixture {
  provider: OidcProvider;
  sign: (opts?: {
    sub?: string | null;
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    signWith?: CryptoKey;
  }) => Promise<string>;
  otherKey: CryptoKey;
}

let keyCounter = 0;

async function makeFixture(
  name: string,
  issuer: string,
  audience: string,
): Promise<Fixture> {
  const kid = `test-key-${++keyCounter}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });

  // An unrelated key the JWKS does not know about, for bad-signature tests.
  const { privateKey: otherKey } = await generateKeyPair("RS256");

  const provider: OidcProvider = { name, issuers: [issuer], audiences: [audience], jwks };

  const sign: Fixture["sign"] = async (opts = {}) => {
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(opts.issuer ?? issuer)
      .setAudience(opts.audience ?? audience)
      .setExpirationTime(opts.expiresIn ?? "5m")
      .setIssuedAt();
    if (opts.sub !== null) jwt.setSubject(opts.sub ?? "user-123");
    return jwt.sign(opts.signWith ?? privateKey);
  };

  return { provider, sign, otherKey };
}

test("verifyIdToken accepts a valid Apple id-token and namespaces the userId", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const token = await apple.sign({ sub: "000123.abcDEF.4567" });

  const identity = await verifyIdToken(token, [apple.provider]);

  expect(identity).toEqual({
    userId: "apple:000123.abcDEF.4567",
    provider: "apple",
    audience: APPLE_AUD,
  });
});

test("verifyIdToken picks the right provider from a multi-provider list", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const google = await makeFixture("google", GOOGLE_ISS, GOOGLE_AUD);
  const token = await google.sign({ sub: "9988776655" });

  const identity = await verifyIdToken(token, [apple.provider, google.provider]);

  expect(identity).toEqual({
    userId: "google:9988776655",
    provider: "google",
    audience: GOOGLE_AUD,
  });
});

test("verifyIdToken rejects a wrong audience", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const token = await apple.sign({ audience: "com.someone.else" });

  expect(await verifyIdToken(token, [apple.provider])).toBeNull();
});

test("verifyIdToken rejects a wrong issuer", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const token = await apple.sign({ issuer: "https://evil.example.com" });

  expect(await verifyIdToken(token, [apple.provider])).toBeNull();
});

test("verifyIdToken rejects an expired token", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const token = await apple.sign({ expiresIn: Math.floor(Date.now() / 1000) - 60 });

  expect(await verifyIdToken(token, [apple.provider])).toBeNull();
});

test("verifyIdToken rejects a token signed by an unknown key", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const token = await apple.sign({ signWith: apple.otherKey });

  expect(await verifyIdToken(token, [apple.provider])).toBeNull();
});

test("verifyIdToken rejects a token with no subject", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const token = await apple.sign({ sub: null });

  expect(await verifyIdToken(token, [apple.provider])).toBeNull();
});

test("verifyIdToken rejects a malformed token", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  expect(await verifyIdToken("not-a-jwt", [apple.provider])).toBeNull();
});

function get(headers: Record<string, string> = {}): Request {
  return new Request("https://backend.example/api/upload", { method: "POST", headers });
}

test("requestContext (public mode) rejects a missing bearer token", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const res = await requestContext(get(), {}, { oidcProviders: [apple.provider] });

  expect(res).toBeInstanceOf(Response);
  expect((res as Response).status).toBe(401);
});

test("requestContext (public mode) rejects an invalid bearer token", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const res = await requestContext(
    get({ authorization: "Bearer forged" }),
    {},
    { oidcProviders: [apple.provider] },
  );

  expect((res as Response).status).toBe(401);
});

test("requestContext (public mode) ignores a spoofed user-id header", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const token = await apple.sign({ sub: "real-user" });
  const res = await requestContext(
    get({ authorization: `Bearer ${token}`, "x-nativread-user-id": "victim" }),
    {},
    { oidcProviders: [apple.provider] },
  );

  expect(res).toEqual({ userId: "apple:real-user" });
});

test("requestContext accepts a NativRead session after the Apple id-token exchange", async () => {
  const apple = await makeFixture("apple", APPLE_ISS, APPLE_AUD);
  const sessionSecret = "test-session-secret-that-is-longer-than-32-bytes";
  const token = await createSessionToken("apple:returning-user", sessionSecret);
  const res = await requestContext(
    get({ authorization: `Bearer ${token}` }),
    { sessionSecret },
    { oidcProviders: [apple.provider] },
  );

  expect(res).toEqual({ userId: "apple:returning-user" });
});

test("requestContext (dev mode, no login configured) trusts the user-id header", async () => {
  const res = await requestContext(get({ "x-nativread-user-id": "local-dev" }), {});
  expect(res).toEqual({ userId: "local-dev" });
});

test("requestContext (dev mode) defaults to 'local' with no header", async () => {
  const res = await requestContext(get(), {});
  expect(res).toEqual({ userId: "local" });
});

test("requestContext (dev mode) enforces the shared secret when set", async () => {
  const config = { mobileSharedSecret: "s3cret" };
  const bad = await requestContext(get({ "x-nativread-api-key": "wrong" }), config);
  expect((bad as Response).status).toBe(401);

  const ok = await requestContext(
    get({ "x-nativread-api-key": "s3cret", "x-nativread-user-id": "u1" }),
    config,
  );
  expect(ok).toEqual({ userId: "u1" });
});
