import { test, expect } from "bun:test";
import { validateChunk } from "../lib/core/quality/validators.ts";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE } from "../lib/core/markup.ts";

const OPTS = { minLengthRatio: 0.6, maxLengthRatio: 2.2 };
const tok = (n: number) => `${PLACEHOLDER_OPEN}${n}${PLACEHOLDER_CLOSE}`;

test("clean chunk reports ok with no flags", () => {
  const r = validateChunk(
    { sourcePlain: "Hello world.", targetPlain: "Helló világ.", sourceTokenized: "Hello world.", targetTokenized: "Helló világ.", glossary: {} },
    OPTS,
  );
  expect(r.ok).toBe(true);
  expect(r.flags).toEqual([]);
});

test("flags omission when translation is far too short", () => {
  const r = validateChunk(
    { sourcePlain: "A".repeat(400), targetPlain: "A".repeat(40), sourceTokenized: "x", targetTokenized: "x", glossary: {} },
    OPTS,
  );
  expect(r.flags).toContain("omission");
  expect(r.ok).toBe(false);
});

test("skips the length check on text too short for the ratio to mean anything", () => {
  // A heading rendered a few characters longer is not evidence of anything.
  const r = validateChunk(
    { sourcePlain: "Chapter One", targetPlain: "Első fejezet", sourceTokenized: "x", targetTokenized: "x", glossary: {} },
    { minLengthRatio: 0.95, maxLengthRatio: 1.05 },
  );
  expect(r.flags).not.toContain("omission");
});

test("flags token loss when a placeholder is dropped", () => {
  const r = validateChunk(
    { sourcePlain: "a b", targetPlain: "a b", sourceTokenized: `a ${tok(0)} b`, targetTokenized: "a b", glossary: {} },
    OPTS,
  );
  expect(r.flags).toContain("tokens");
});

test("accepts a Hungarian-suffixed rendering as present", () => {
  // "Melissa" + "-val" is "Melissával": the stem's final vowel lengthens, so the plain
  // substring is gone even though the term was used exactly as agreed.
  const r = validateChunk(
    {
      sourcePlain: "Melissa smiled at Klein.",
      targetPlain: "Klein Melissával beszélt.",
      sourceTokenized: "x",
      targetTokenized: "x",
      glossary: { Melissa: "Melissa", Klein: "Klein" },
    },
    OPTS,
  );
  expect(r.missingGlossary).toEqual([]);
  expect(r.flags).not.toContain("glossary");
});

test("flags glossary miss when target rendering is absent", () => {
  const r = validateChunk(
    { sourcePlain: "Mr. Holloway arrived.", targetPlain: "Valaki megérkezett.", sourceTokenized: "x", targetTokenized: "x", glossary: { "Mr. Holloway": "Holloway úr" } },
    OPTS,
  );
  expect(r.flags).toContain("glossary");
  expect(r.missingGlossary).toContain("Mr. Holloway");
});
