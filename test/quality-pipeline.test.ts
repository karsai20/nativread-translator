import { test, expect } from "bun:test";
import { translateBlocks } from "../lib/core/translator.ts";
import type { RefineChunkInput, Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { FakeTranslator, FAKE_REFINE_TAG } from "../lib/core/providers/fake.ts";
import { diagnosisInstruction } from "../lib/core/providers/prompts.ts";
import { blockMarker } from "../lib/core/markup.ts";

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

const threeBlocks = [
  { index: 0, innerHtml: "The harbour was quiet that morning." },
  { index: 1, innerHtml: "He found a letter on the hall table." },
  { index: 2, innerHtml: "The fire had gone out during the night." },
];

test("refines only the blocks the judge flagged and keeps the clean ones", async () => {
  const fake = new FakeTranslator();
  const seen: RefineChunkInput[] = [];
  const provider: Translator = {
    name: "p",
    translateChunk: (i: TranslateChunkInput) => fake.translateChunk(i),
    refineChunk: (i) => { seen.push(i); return fake.refineChunk(i); },
    async estimateChunk() {
      return { needsRefine: true, score: 3, weakBlocks: [1], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  const res = await translateBlocks(provider, threeBlocks, {
    glossary: {}, refine: true, selectiveRefine: true, precision: "balanced",
  });

  // Only block 1 was sent for rework — the other two never reached the refine call.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]!.draft).toContain(blockMarker(1));
  expect(seen[0]!.draft).not.toContain(blockMarker(0));
  expect(seen[0]!.draft).not.toContain(blockMarker(2));
  // ...and only block 1 comes back polished, with the rest spliced through untouched.
  const byIndex = new Map(res.blocks.map((b) => [b.index, b.html]));
  expect(byIndex.get(1)).toContain(FAKE_REFINE_TAG);
  expect(byIndex.get(0)).not.toContain(FAKE_REFINE_TAG);
  expect(byIndex.get(2)).not.toContain(FAKE_REFINE_TAG);
  // Nothing is lost by scoping: every block still has its text.
  expect(byIndex.get(0)).toContain("HARBOUR");
  expect(byIndex.get(2)).toContain("FIRE");
});

test("hands the refine pass the diagnosis instead of a blind polish request", async () => {
  const seen: RefineChunkInput[] = [];
  const provider: Translator = {
    name: "p",
    // The book agreed to render "Holloway" as "Kovács"; this draft ignores it, which is
    // exactly the defect the local validator exists to catch.
    async translateChunk(input: TranslateChunkInput) {
      const marker = input.text.match(/^\S+/)?.[0] ?? "";
      return { text: `${marker}\nValaki várt.`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    refineChunk: (i) => {
      seen.push(i);
      return Promise.resolve({ text: i.draft, usage: { inputTokens: 1, outputTokens: 1 } });
    },
    async estimateChunk() {
      return { needsRefine: true, score: 3, fluency: true, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  await translateBlocks(provider, [{ index: 0, innerHtml: "Mr. Holloway waited." }], {
    glossary: { Holloway: "Kovács" }, refine: true, selectiveRefine: true, precision: "balanced",
  });

  expect(seen[0]!.diagnosis?.missingGlossary).toContain("Holloway");
  expect(seen[0]!.diagnosis?.fluency).toBe(true);
});

test("catches a chunk that quietly dropped content, at measured EN->HU proportions", async () => {
  // 0.85 of the source: what a real run produced when it silently swallowed a whole
  // paragraph of dialogue. Healthy chunks measure 0.91-1.04, so this must not pass.
  const source = "Klein waited by the door and counted the lamps along the harbour road. ".repeat(6);
  const seen: RefineChunkInput[] = [];
  const provider: Translator = {
    name: "lossy",
    async translateChunk(input: TranslateChunkInput) {
      const marker = input.text.match(/^\S+/)?.[0] ?? "";
      const body = "Klein az ajtónál várt és számolta a lámpákat az úton. ".repeat(5);
      return { text: `${marker}\n${body}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    refineChunk: (i) => {
      seen.push(i);
      return Promise.resolve({ text: i.draft, usage: { inputTokens: 1, outputTokens: 1 } });
    },
    async estimateChunk() {
      return { needsRefine: false, score: 5, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  await translateBlocks(provider, [{ index: 0, innerHtml: source }], {
    glossary: {}, refine: true, selectiveRefine: true, precision: "balanced",
  });

  // The judge called it publishable; the length check is what saves the paragraph.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]!.diagnosis?.flags).toContain("omission");
});

test("renders the diagnosis as concrete instructions, and nothing when there is none", () => {
  const text = diagnosisInstruction({
    flags: ["glossary", "omission"],
    missingGlossary: ["Holloway", "Sarah"],
    accuracy: true,
  });
  expect(text).toContain("Holloway");
  expect(text).toContain("Sarah");
  expect(text.toLowerCase()).toContain("missing");
  expect(text.toLowerCase()).toContain("meaning is wrong");

  expect(diagnosisInstruction(undefined)).toBe("");
  expect(diagnosisInstruction({ flags: [], missingGlossary: [] })).toBe("");
});
