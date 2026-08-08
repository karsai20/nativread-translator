import { test, expect } from "bun:test";
import {
  DEFAULT_PAIR,
  PAIRS,
  distinctStopwords,
  isValidatedPair,
  languageName,
  lengthBandFor,
  policyFor,
  validatedPairs,
} from "../lib/core/languages.ts";
import { guardChunk } from "../lib/core/quality/guard.ts";
import { markerSentence } from "../lib/core/ai-marker.ts";

// The release gate. If this test starts failing, a pair was opened — which is
// only correct alongside a full-novel run and a native read (blueprint §3).
test("English to Hungarian is the only pair the API accepts", () => {
  expect(validatedPairs().map((p) => `${p.source}-${p.target}`)).toEqual(["en-hu"]);
  expect(isValidatedPair({ source: "en", target: "hu" })).toBe(true);
  expect(isValidatedPair({ source: "en", target: "de" })).toBe(false);
  expect(isValidatedPair({ source: "es", target: "en" })).toBe(false);
});

test("every wired pair carries a length band, so flipping one needs no other edit", () => {
  for (const policy of PAIRS) {
    for (const mode of ["balanced", "fidelity"] as const) {
      const [min, max] = lengthBandFor(policy, mode);
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(min);
    }
  }
  // The measured en->hu band must not be replaced by the unmeasured default.
  expect(lengthBandFor(DEFAULT_PAIR, "fidelity")).toEqual([0.92, 1.25]);
  expect(lengthBandFor({ source: "en", target: "de" }, "fidelity")).not.toEqual([0.92, 1.25]);
});

test("an unknown pair still yields a usable band rather than crashing", () => {
  expect(policyFor({ source: "hu", target: "de" })).toBeUndefined();
  const [min, max] = lengthBandFor({ source: "hu", target: "de" }, "balanced");
  expect(max).toBeGreaterThan(min);
});

test("stopword counting distinguishes the languages it gates on", () => {
  const english = "The old man was walking with his dog when they found her letter.";
  expect(distinctStopwords(english, "en")).toBeGreaterThanOrEqual(3);
  expect(distinctStopwords(english, "hu")).toBeLessThan(3);
});

// The guard used to decide "untranslated" by looking for Hungarian accents.
// These two prove the replacement works for a pair that has no accent rule.
test("guard flags English left in place when the target is German", () => {
  const english =
    "The old man was walking with his dog when they found her letter on the table.";
  const report = guardChunk(
    [{ index: 0, sourcePlain: english, targetHtml: english, targetPlain: english }],
    { source: "en", target: "de" },
  );
  expect(report.ok).toBe(false);
  expect(report.reasons[0]!.reason).toBe("untranslated");
});

test("guard passes a real German translation of that English source", () => {
  const english =
    "The old man was walking with his dog when they found her letter on the table.";
  const german =
    "Der alte Mann ging mit seinem Hund spazieren, als sie ihren Brief auf dem Tisch fanden.";
  const report = guardChunk(
    [{ index: 0, sourcePlain: english, targetHtml: german, targetPlain: german }],
    { source: "en", target: "de" },
  );
  expect(report.ok).toBe(true);
});

test("the AI Act marker names the real pair, not a constant", () => {
  expect(markerSentence({ sourceLang: "es", targetLang: "en" })).toContain(
    "from Spanish to English",
  );
  expect(languageName("hu")).toBe("Hungarian");
});
