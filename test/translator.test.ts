import { test, expect } from "bun:test";
import { translateBlocks, TranslationGuardError } from "../lib/core/translator.ts";
import type { Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { FakeTranslator, FAKE_REFINE_TAG } from "../lib/core/providers/fake.ts";
import { splitBlockSegments, BLOCK_MARKER_OPEN, BLOCK_MARKER_CLOSE } from "../lib/core/markup.ts";
import { TEXT_SEGMENT_OPEN, TEXT_SEGMENT_CLOSE } from "../lib/core/html-segments.ts";

const REFUSAL = "Sorry, I can't generate a translation for this passage.";

const STRIP_MARKERS = new RegExp(`[${BLOCK_MARKER_OPEN}${BLOCK_MARKER_CLOSE}]`, "g");
const STRIP_TEXT_SEGMENTS = new RegExp(`[${TEXT_SEGMENT_OPEN}${TEXT_SEGMENT_CLOSE}]`, "g");

const blocks = [
  { index: 0, innerHtml: "Mr. Holloway walked into the <em>old</em> library." },
  { index: 1, innerHtml: 'He found a <a href="x.xhtml">letter</a>.' },
  { index: 2, innerHtml: "" }, // empty/image-only block — must be preserved untouched
];

test("translates all blocks in ONE provider call with full context", async () => {
  let calls = 0;
  let sawMultipleBlocks = false;
  const spy: Translator = {
    name: "spy",
    async translateChunk(input: TranslateChunkInput) {
      calls += 1;
      // The payload must contain BOTH translatable blocks (context-aware), not one.
      sawMultipleBlocks = splitBlockSegments(input.text).length === 2;
      return new FakeTranslator().translateChunk(input);
    },
  };

  const res = await translateBlocks(spy, blocks, { glossary: {} });

  expect(calls).toBe(1);
  expect(sawMultipleBlocks).toBe(true);
  expect(res.blocks).toHaveLength(3);
  expect(res.blocks[2]!.html).toBe(""); // empty block preserved
  expect(res.blocks[0]!.html).toContain("<em>"); // inline markup restored
  expect(res.blocks[1]!.html).toContain('href="x.xhtml"');
  expect(res.plainText.length).toBeGreaterThan(0);
});

test("refine pass runs when enabled and provider supports it", async () => {
  const res = await translateBlocks(new FakeTranslator(), blocks, { glossary: {}, refine: true });
  // The fake refine tags the output so we can see the second pass ran.
  expect(res.blocks[0]!.html).toContain(FAKE_REFINE_TAG);
});

test("selective refine skips the polish when the estimate judges the draft strong", async () => {
  // The fake estimator returns needsRefine:false, so no refine tag should appear.
  const res = await translateBlocks(new FakeTranslator(), blocks, {
    glossary: {},
    refine: true,
    selectiveRefine: true,
  });
  expect(res.blocks[0]!.html).not.toContain(FAKE_REFINE_TAG);
});

test("selective refine runs the polish when the estimate judges the draft weak", async () => {
  const fake = new FakeTranslator();
  let estimateCalls = 0;
  const weakJudge: Translator = {
    name: "weak-judge",
    translateChunk: (input) => fake.translateChunk(input),
    refineChunk: (input) => fake.refineChunk(input),
    async estimateChunk(input) {
      estimateCalls += 1;
      return { needsRefine: true, score: 2, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  const res = await translateBlocks(weakJudge, blocks, { glossary: {}, refine: true, selectiveRefine: true });
  // The adaptive loop re-judges after each refine (bounded by MAX_QUALITY_ITERATIONS),
  // so a persistently weak draft is judged 1–2 times and gets the polish.
  expect(estimateCalls).toBeGreaterThanOrEqual(1);
  expect(estimateCalls).toBeLessThanOrEqual(2);
  expect(res.blocks[0]!.html).toContain(FAKE_REFINE_TAG);
});

test("the hardest drafts are refined with the deep (reasoning) flag", async () => {
  const fake = new FakeTranslator();
  let deepSeen: boolean | undefined;
  const hardJudge: Translator = {
    name: "hard-judge",
    translateChunk: (input) => fake.translateChunk(input),
    refineChunk: (input) => {
      deepSeen = input.deep;
      return fake.refineChunk(input);
    },
    async estimateChunk() {
      return { needsRefine: true, hard: true, score: 1, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  await translateBlocks(hardJudge, blocks, {
    glossary: {},
    refine: true,
    selectiveRefine: true,
    reasonerForHard: true,
  });
  expect(deepSeen).toBe(true);
});

test("falls back to per-block translation when a block marker goes missing", async () => {
  let calls = 0;
  // A broken provider that strips all markers on the first (multi-block) call, forcing
  // the fallback path; subsequent single-block calls succeed.
  const broken: Translator = {
    name: "broken",
    async translateChunk(input: TranslateChunkInput) {
      calls += 1;
      const out = await new FakeTranslator().translateChunk(input);
      if (calls === 1) return { ...out, text: out.text.replace(STRIP_MARKERS, "") };
      return out;
    },
  };

  const res = await translateBlocks(broken, blocks, { glossary: {} });
  // 1 failed multi-block call + 2 per-block fallback calls (the empty block is skipped).
  expect(calls).toBe(3);
  expect(res.blocks[0]!.html).toContain("<em>");
  expect(res.blocks[1]!.html).toContain('href="x.xhtml"');
});

test("preserves nested formatting and links even when text-node markers are dropped", async () => {
  const markerDropper: Translator = {
    name: "marker-dropper",
    async translateChunk(input: TranslateChunkInput) {
      const out = await new FakeTranslator().translateChunk(input);
      return { ...out, text: out.text.replace(STRIP_TEXT_SEGMENTS, "") };
    },
  };

  const res = await translateBlocks(markerDropper, [
    {
      index: 0,
      innerHtml: 'He <em>found <a class="xref" href="ch2.xhtml">the letter</a></em>.',
    },
  ], { glossary: {} });

  const html = res.blocks[0]!.html;
  expect(html).toContain("<em>");
  expect(html).toContain('<a class="xref" href="ch2.xhtml">');
  expect(html).toContain("</a></em>");
});

test("guard re-translates deterministically when the first draft refuses, then succeeds", async () => {
  const fake = new FakeTranslator();
  let detSeen = false;
  const flakyRefuser: Translator = {
    name: "flaky-refuser",
    async translateChunk(input: TranslateChunkInput) {
      // First (sampled) attempt refuses; the guard's deterministic retry gets a real one.
      if (input.deterministic) {
        detSeen = true;
        return fake.translateChunk(input);
      }
      return { text: REFUSAL, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  const res = await translateBlocks(flakyRefuser, blocks, { glossary: {} });
  expect(detSeen).toBe(true);
  expect(res.blocks[0]!.html).toContain("<em>"); // clean retry output, markup restored
  expect(res.blocks[1]!.html).toContain('href="x.xhtml"');
});

test("guard fails the chunk when the model refuses even on the deterministic retry", async () => {
  const alwaysRefuse: Translator = {
    name: "always-refuse",
    async translateChunk() {
      return { text: REFUSAL, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  await expect(translateBlocks(alwaysRefuse, blocks, { glossary: {} })).rejects.toBeInstanceOf(TranslationGuardError);
});

test("glossary target renderings are applied", async () => {
  const res = await translateBlocks(new FakeTranslator(), [{ index: 0, innerHtml: "Mr. Holloway" }], {
    glossary: { "Mr. Holloway": "Holloway úr" },
  });
  // The fake uppercases everything; assert case-insensitively that the glossary
  // target rendering (not the source term) came through.
  expect(res.blocks[0]!.html.toLowerCase()).toContain("holloway úr");
});
