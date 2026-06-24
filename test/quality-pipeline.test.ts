import { test, expect } from "bun:test";
import { translateBlocks } from "../lib/core/translator.ts";
import type { Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { FakeTranslator, FAKE_REFINE_TAG } from "../lib/core/providers/fake.ts";

const blocks = [
  { index: 0, innerHtml: "Mr. Holloway walked into the old library." },
  { index: 1, innerHtml: "He found a letter." },
];

test("accepts without refine when local checks pass and judge scores high", async () => {
  const fake = new FakeTranslator();
  let refines = 0;
  const provider: Translator = {
    name: "p",
    translateChunk: (i: TranslateChunkInput) => fake.translateChunk(i),
    refineChunk: (i) => { refines++; return fake.refineChunk(i); },
    async estimateChunk() { return { needsRefine: false, score: 5, omission: false, usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
  const res = await translateBlocks(provider, blocks, { glossary: {}, refine: true, selectiveRefine: true, precision: "balanced" });
  expect(refines).toBe(0);
  expect(res.blocks[0]!.html).not.toContain(FAKE_REFINE_TAG);
});

test("escalates with deep=true on an omission flag the old needsRefine bit would miss", async () => {
  const fake = new FakeTranslator();
  let deepSeen: boolean | undefined;
  let refines = 0;
  const provider: Translator = {
    name: "p",
    translateChunk: (i: TranslateChunkInput) => fake.translateChunk(i),
    refineChunk: (i) => { refines++; deepSeen = i.deep; return fake.refineChunk(i); },
    // Judge says "no refine needed" by the legacy bit, but reports an omission: the
    // new routing must still escalate on the fidelity flag.
    async estimateChunk() { return { needsRefine: false, score: 4, omission: true, usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
  await translateBlocks(provider, blocks, { glossary: {}, refine: true, selectiveRefine: true, reasonerForHard: true, precision: "balanced" });
  expect(refines).toBeGreaterThan(0);
  expect(deepSeen).toBe(true);
});
