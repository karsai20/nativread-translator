import { expect, test } from "bun:test";

import { createSessionToken, verifySessionToken } from "../lib/server/session.ts";

const secret = "test-session-secret-that-is-longer-than-32-bytes";

test("session round-trip preserves the provider-namespaced user id", async () => {
  const token = await createSessionToken("apple:user-123", secret);
  expect(await verifySessionToken(token, secret)).toBe("apple:user-123");
});

test("session rejects the wrong secret and malformed tokens", async () => {
  const token = await createSessionToken("apple:user-123", secret);
  expect(
    await verifySessionToken(
      token,
      "another-session-secret-that-is-long-enough",
    ),
  ).toBeNull();
  expect(await verifySessionToken("not-a-jwt", secret)).toBeNull();
});

test("session refuses a weak signing secret", async () => {
  expect(createSessionToken("apple:user-123", "short")).rejects.toThrow();
});
