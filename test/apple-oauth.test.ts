import { expect, test } from "bun:test";
import { exportPKCS8, generateKeyPair } from "jose";

import { revokeAppleAuthorizationCode } from "../lib/server/apple-oauth.ts";

async function credentials() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    clientId: "com.karsai.nativread",
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey: await exportPKCS8(privateKey),
  };
}

test("Apple account deletion exchanges a fresh code then revokes the refresh token", async () => {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    if (calls.length === 1) {
      return Response.json({ refresh_token: "apple-refresh-token" });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  await revokeAppleAuthorizationCode(
    "fresh-one-time-code",
    await credentials(),
    fetcher,
  );

  expect(calls).toHaveLength(2);
  expect(calls[0].url).toBe("https://appleid.apple.com/auth/token");
  expect(calls[0].body.get("code")).toBe("fresh-one-time-code");
  expect(calls[0].body.get("grant_type")).toBe("authorization_code");
  expect(calls[1].url).toBe("https://appleid.apple.com/auth/revoke");
  expect(calls[1].body.get("token")).toBe("apple-refresh-token");
  expect(calls[1].body.get("token_type_hint")).toBe("refresh_token");
});

test("Apple exchange failure never attempts revocation", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as typeof fetch;

  await expect(
    revokeAppleAuthorizationCode("bad-code", await credentials(), fetcher),
  ).rejects.toThrow("exchange failed");
  expect(calls).toBe(1);
});
