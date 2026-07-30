import { test, expect } from "bun:test";
import { guardChunk } from "../lib/core/quality/guard.ts";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE } from "../lib/core/markup.ts";

const block = (over: Partial<{ index: number; sourcePlain: string; targetHtml: string; targetPlain: string }> = {}) => ({
  index: 0,
  sourcePlain: "He walked into the old library and found a letter from Sarah.",
  targetHtml: "Belépett a régi könyvtárba, és talált egy levelet Saráról.",
  targetPlain: "Belépett a régi könyvtárba, és talált egy levelet Saráról.",
  ...over,
});

test("a clean Hungarian translation passes", () => {
  const r = guardChunk([block()]);
  expect(r.ok).toBe(true);
  expect(r.reasons).toEqual([]);
});

test("flags a model refusal baked into the output", () => {
  const r = guardChunk([
    block({ targetHtml: "Sorry, I can't generate a translation for a passage that includes copyright boilerplate.", targetPlain: "Sorry, I can't generate a translation for a passage that includes copyright boilerplate." }),
  ]);
  expect(r.ok).toBe(false);
  expect(r.reasons[0]!.reason).toBe("refusal");
});

test("flags chain-of-thought leaked in another language (CJK)", () => {
  const cjk = "**注意**：如果这是单个句子，规则是保持每个标记原样。";
  const r = guardChunk([block({ targetHtml: cjk, targetPlain: cjk })]);
  expect(r.ok).toBe(false);
  expect(r.reasons[0]!.reason).toBe("foreign");
});

test("flags untranslated / degenerate English left in place", () => {
  // The real production gibberish: English words, no Hungarian accents.
  const eng = "Space in he our Some old was moments many night bed It yet so up she lay happen with the and that have his her.";
  const r = guardChunk([block({ targetHtml: eng, targetPlain: eng })]);
  expect(r.ok).toBe(false);
  expect(r.reasons[0]!.reason).toBe("untranslated");
});

test("flags a leaked placeholder sentinel (token corruption)", () => {
  const leaked = `Belépett a régi ${PLACEHOLDER_OPEN}2${PLACEHOLDER_CLOSE} könyvtárba.`;
  const r = guardChunk([block({ targetHtml: leaked, targetPlain: leaked })]);
  expect(r.ok).toBe(false);
  expect(r.reasons[0]!.reason).toBe("residual");
});

test("does not flag a short accent-free Hungarian fragment", () => {
  // Short proper-noun / dialogue fragment without accents must not be a false positive.
  const r = guardChunk([block({ sourcePlain: "Tom.", targetHtml: "Tom.", targetPlain: "Tom." })]);
  expect(r.ok).toBe(true);
});

test("does not flag an empty (image-only) block", () => {
  const r = guardChunk([block({ sourcePlain: "", targetHtml: "", targetPlain: "" })]);
  expect(r.ok).toBe(true);
});
