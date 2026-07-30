import { describe, expect, test } from "bun:test";

import {
  HttpError,
  bearerToken,
  objectPrefix,
  parseSmallJson,
  resultKey,
  securityHeaders,
  sha256,
  sourceKey,
} from "../src/security";
import { validateTermsAcceptance } from "../src/legal";

const USER_ID = "a".repeat(64);
const JOB_ID = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a021";

describe("Cloudflare security boundary", () => {
  test("derives only server-controlled user-scoped object keys", () => {
    expect(objectPrefix(USER_ID)).toBe(`users/${USER_ID}/`);
    expect(sourceKey(USER_ID, JOB_ID)).toBe(`users/${USER_ID}/jobs/${JOB_ID}/source.epub`);
    expect(resultKey(USER_ID, JOB_ID)).toBe(`users/${USER_ID}/jobs/${JOB_ID}/result.epub`);
    expect(() => objectPrefix("../victim")).toThrow();
    expect(() => sourceKey(USER_ID, "../../victim------------------------")).toThrow();
  });

  test("accepts one strict bearer token and rejects header smuggling shapes", () => {
    expect(bearerToken(new Request("https://example.test", {
      headers: { authorization: "Bearer abc.def_123-xyz" },
    }))).toBe("abc.def_123-xyz");
    expect(bearerToken(new Request("https://example.test", {
      headers: { authorization: "Bearer good, Bearer second" },
    }))).toBeNull();
    expect(bearerToken(new Request("https://example.test", {
      headers: { authorization: "Basic abc" },
    }))).toBeNull();
  });

  test("limits JSON bodies even when Content-Length is absent", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 10) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(800).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await expect(parseSmallJson(request, 1_024)).rejects.toEqual(
      expect.objectContaining<HttpError>({ status: 413 }),
    );
    expect(cancelled).toBeTrue();
    expect(pulls).toBeLessThan(10);
  });

  test("sets defensive no-store and browser hardening headers", () => {
    const headers = securityHeaders();
    expect(headers.get("cache-control")).toContain("no-store");
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
  });

  test("uses deterministic SHA-256 without retaining raw Apple subjects", async () => {
    expect(await sha256("apple:subject")).toMatch(/^[a-f0-9]{64}$/u);
    expect(await sha256("apple:subject")).not.toContain("subject");
    expect(await sha256("apple:subject")).not.toBe(await sha256("apple:other"));
  });

  test("accepts only a current, explicit and versioned iOS clickwrap record", () => {
    const env = {
      TERMS_EFFECTIVE_AT: "2026-07-22T00:00:00Z",
      RIGHTS_ATTESTATION_VERSION: "2026-07-22",
    };
    const now = Date.parse("2026-07-22T12:00:00Z");
    expect(validateTermsAcceptance({
      id: JOB_ID,
      acceptedAt: "2026-07-22T11:59:00Z",
      locale: "hu-HU",
      method: "ios-clickwrap",
      statementVersion: "2026-07-22",
    }, env, now)).toEqual(expect.objectContaining({ method: "ios-clickwrap" }));
    expect(() => validateTermsAcceptance({
      id: JOB_ID,
      acceptedAt: "2026-07-22T11:59:00Z",
      locale: "hu-HU",
      method: "implicit",
      statementVersion: "2026-07-22",
    }, env, now)).toThrow();
    expect(() => validateTermsAcceptance({
      id: JOB_ID,
      acceptedAt: "2026-07-21T23:59:59Z",
      locale: "hu-HU",
      method: "ios-clickwrap",
      statementVersion: "2026-07-22",
    }, env, now)).toThrow();
  });
});
