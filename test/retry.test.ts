import { test, expect } from "bun:test";
import {
  withRetry,
  RetryableError,
  CancelledError,
  isRetryable,
  parseRetryAfterMs,
} from "../lib/core/retry.ts";

const noSleep = async () => {};
const never = () => new Promise<never>(() => {});

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

test("isRetryable: RetryableError yes, plain Error no, CancelledError no", () => {
  expect(isRetryable(new RetryableError("x"))).toBe(true);
  expect(isRetryable(new TypeError("network"))).toBe(true);
  expect(isRetryable(new Error("nope"))).toBe(false);
  expect(isRetryable(new CancelledError())).toBe(false);
});

test("hard timeout rejects even when the attempt ignores abort (the hang fix)", async () => {
  // `never` never settles and never honors the signal — the old code hung forever here.
  await expect(
    withRetry(never, { retries: 0, timeoutMs: 20, sleep: noSleep }),
  ).rejects.toThrow("időtúllépett");
});

test("a pre-aborted parent signal fails fast with CancelledError", async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await expect(
    withRetry(
      () => {
        calls += 1;
        return Promise.resolve("ok");
      },
      { signal: ac.signal },
    ),
  ).rejects.toBeInstanceOf(CancelledError);
  expect(calls).toBe(0); // never even attempted
});

test("aborting the parent signal mid-flight cancels without retrying", async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = withRetry(
    () => {
      calls += 1;
      return never();
    },
    { retries: 4, timeoutMs: 5000, sleep: noSleep, signal: ac.signal },
  );
  ac.abort();
  await expect(p).rejects.toBeInstanceOf(CancelledError);
  expect(calls).toBe(1); // single attempt, no retry on cancellation
});

test("parseRetryAfterMs reads seconds", () => {
  expect(parseRetryAfterMs("2")).toBe(2000);
  expect(parseRetryAfterMs(null)).toBeUndefined();
  expect(parseRetryAfterMs("garbage")).toBeUndefined();
});
