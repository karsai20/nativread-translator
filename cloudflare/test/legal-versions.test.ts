import { test, expect } from "bun:test";
import {
  honouredVersions,
  termsReleaseFor,
  termsReleases,
  validateTermsAcceptance,
} from "../src/legal.ts";

const env = {
  TERMS_VERSION: "2026-08-05",
  TERMS_EFFECTIVE_AT: "2026-08-05T00:00:00Z",
  TERMS_DOCUMENT_URL: "https://nativread.com/terms/2026-08-05/",
  TERMS_SUPERSEDED: [
    {
      version: "2026-07-22",
      effectiveAt: "2026-07-22T00:00:00Z",
      documentUrl: "https://nativread.com/terms/2026-07-22/",
    },
  ],
  RIGHTS_ATTESTATION_VERSION: "2026-07-22",
  RIGHTS_ATTESTATION_SUPERSEDED: [],
};

const acceptance = (over: Record<string, unknown> = {}) => ({
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  acceptedAt: "2026-08-05T10:00:00Z",
  locale: "hu-HU",
  method: "ios-clickwrap",
  statementVersion: "2026-07-22",
  ...over,
});

const now = Date.parse("2026-08-06T00:00:00Z");

test("the current release is offered first and resolves", () => {
  expect(termsReleases(env).map((r) => r.version)).toEqual(["2026-08-05", "2026-07-22"]);
  expect(termsReleaseFor("2026-08-05", env)?.documentUrl).toBe(
    "https://nativread.com/terms/2026-08-05/",
  );
});

// The whole point: an app build that predates the deploy keeps working.
test("a superseded release is honoured with its own date and document", () => {
  const release = termsReleaseFor("2026-07-22", env);
  expect(release).toBeDefined();
  expect(release!.documentUrl).toBe("https://nativread.com/terms/2026-07-22/");

  // Accepted before the *current* terms existed — valid against its own release.
  const input = validateTermsAcceptance(
    acceptance({ acceptedAt: "2026-07-23T10:00:00Z" }), env, release!, now,
  );
  expect(input.statementVersion).toBe("2026-07-22");
});

test("that same click is rejected against the current release", () => {
  expect(() =>
    validateTermsAcceptance(
      acceptance({ acceptedAt: "2026-07-23T10:00:00Z" }),
      env,
      termsReleaseFor("2026-08-05", env)!,
      now,
    )
  ).toThrow();
});

test("a version that was never published is not honoured", () => {
  expect(termsReleaseFor("2025-01-01", env)).toBeUndefined();
  expect(termsReleaseFor(undefined, env)).toBeUndefined();
  expect(termsReleaseFor(42, env)).toBeUndefined();
});

// A malformed list must narrow what is accepted, never widen it.
test("malformed superseded entries are ignored, not trusted", () => {
  const broken = {
    ...env,
    TERMS_SUPERSEDED: [
      { version: "2026-07-22" },
      { version: "x", effectiveAt: "not-a-date", documentUrl: "https://a/" },
      { version: "y", effectiveAt: "2026-07-22T00:00:00Z", documentUrl: "http://insecure/" },
      "2026-07-22",
      null,
    ],
  };
  expect(termsReleases(broken).map((r) => r.version)).toEqual(["2026-08-05"]);
});

test("a superseded entry cannot shadow the current release", () => {
  const shadow = {
    ...env,
    TERMS_SUPERSEDED: [
      {
        version: "2026-08-05",
        effectiveAt: "2020-01-01T00:00:00Z",
        documentUrl: "https://evil.example/terms/",
      },
    ],
  };
  expect(termsReleases(shadow)).toHaveLength(1);
  expect(termsReleaseFor("2026-08-05", shadow)!.documentUrl).toBe(
    "https://nativread.com/terms/2026-08-05/",
  );
});

test("honoured single-string versions include the current one exactly once", () => {
  expect(honouredVersions("2026-07-20-gemini", [])).toEqual(["2026-07-20-gemini"]);
  expect(honouredVersions("b", ["a", "b"])).toEqual(["b", "a"]);
  expect(honouredVersions("b", undefined)).toEqual(["b"]);
  expect(honouredVersions("b", [1, null, "a"])).toEqual(["b", "a"]);
});

test("a rights statement version outside the honoured set is rejected", () => {
  expect(() =>
    validateTermsAcceptance(
      acceptance({ statementVersion: "2020-01-01" }),
      env,
      termsReleaseFor("2026-08-05", env)!,
      now,
    )
  ).toThrow();
});
