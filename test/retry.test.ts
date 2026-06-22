import { test, expect } from "bun:test";
import { withRetry, RetryableError, isRetryable, parseRetryAfterMs } from "../lib/core/retry.ts";

const noSleep = async () => {};

test("retries a transient failure and then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new RetryableError("503");
      return "ok";
    },
    { retries: 4, sleep: noSleep },
  );
  expect(result).toBe("ok");
  expect(calls).toBe(3);
});

test("fails fast on a non-retryable error (no retries)", async () => {
  let calls = 0;
  await expect(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("400 Bad Request");
      },
      { retries: 4, sleep: noSleep },
    ),
  ).rejects.toThrow("400");
  expect(calls).toBe(1);
});

test("exhausts retries then throws the last error", async () => {
  let calls = 0;
  await expect(
    withRetry(
      async () => {
        calls += 1;
        throw new RetryableError("still failing");
      },
      { retries: 2, sleep: noSleep },
    ),
  ).rejects.toThrow("still failing");
  expect(calls).toBe(3); // 1 attempt + 2 retries
});

test("isRetryable: RetryableError yes, plain Error no", () => {
  expect(isRetryable(new RetryableError("x"))).toBe(true);
  expect(isRetryable(new TypeError("network"))).toBe(true);
  expect(isRetryable(new Error("nope"))).toBe(false);
});

test("parseRetryAfterMs reads seconds", () => {
  expect(parseRetryAfterMs("2")).toBe(2000);
  expect(parseRetryAfterMs(null)).toBeUndefined();
  expect(parseRetryAfterMs("garbage")).toBeUndefined();
});
