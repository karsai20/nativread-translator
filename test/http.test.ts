import { test, expect } from "bun:test";
import { fetchWithRetry, HttpError } from "../lib/core/providers/http.ts";

function jsonRes(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function fakeFetch(queue: Response[]): { impl: typeof fetch; calls: () => number } {
  let i = 0;
  const impl = (async () => {
    const r = queue[i++];
    if (!r) throw new Error("no more responses");
    return r;
  }) as unknown as typeof fetch;
  return { impl, calls: () => i };
}

test("retries a 429 then returns the 200", async () => {
  const { impl, calls } = fakeFetch([jsonRes(429), jsonRes(200, "ok")]);
  const slept: number[] = [];
  const res = await fetchWithRetry("https://x", {}, {
    fetchImpl: impl,
    sleepImpl: async (ms) => { slept.push(ms); },
    random: () => 0.5,
  });
  expect(res.status).toBe(200);
  expect(calls()).toBe(2);
  expect(slept.length).toBe(1);
});

test("does NOT retry a 400 and throws HttpError", async () => {
  const { impl, calls } = fakeFetch([jsonRes(400, "bad")]);
  let err: unknown;
  try {
    await fetchWithRetry("https://x", {}, { fetchImpl: impl, sleepImpl: async () => {} });
  } catch (e) { err = e; }
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(400);
  expect(calls()).toBe(1);
});

test("honors Retry-After header (seconds) over computed backoff", async () => {
  const { impl } = fakeFetch([jsonRes(429, "", { "retry-after": "2" }), jsonRes(200)]);
  const slept: number[] = [];
  await fetchWithRetry("https://x", {}, {
    fetchImpl: impl, sleepImpl: async (ms) => { slept.push(ms); }, random: () => 1,
  });
  expect(slept[0]).toBe(2000);
});

test("retries a network error then succeeds", async () => {
  let i = 0;
  const impl = (async () => {
    i++;
    if (i === 1) throw new Error("ECONNRESET");
    return jsonRes(200);
  }) as unknown as typeof fetch;
  const res = await fetchWithRetry("https://x", {}, { fetchImpl: impl, sleepImpl: async () => {} });
  expect(res.status).toBe(200);
  expect(i).toBe(2);
});

test("gives up after maxAttempts and throws", async () => {
  const { impl, calls } = fakeFetch([jsonRes(503), jsonRes(503), jsonRes(503)]);
  let err: unknown;
  try {
    await fetchWithRetry("https://x", {}, { fetchImpl: impl, sleepImpl: async () => {}, maxAttempts: 3 });
  } catch (e) { err = e; }
  expect(err).toBeInstanceOf(HttpError);
  expect(calls()).toBe(3);
});
