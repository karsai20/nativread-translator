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
    { sourcePlain: "A".repeat(100), targetPlain: "A".repeat(10), sourceTokenized: "x", targetTokenized: "x", glossary: {} },
    OPTS,
  );
  expect(r.flags).toContain("omission");
  expect(r.ok).toBe(false);
});

test("flags token loss when a placeholder is dropped", () => {
  const r = validateChunk(
    { sourcePlain: "a b", targetPlain: "a b", sourceTokenized: `a ${tok(0)} b`, targetTokenized: "a b", glossary: {} },
    OPTS,
  );
  expect(r.flags).toContain("tokens");
});

test("flags glossary miss when target rendering is absent", () => {
  const r = validateChunk(
    { sourcePlain: "Mr. Holloway arrived.", targetPlain: "Valaki megérkezett.", sourceTokenized: "x", targetTokenized: "x", glossary: { "Mr. Holloway": "Holloway úr" } },
    OPTS,
  );
  expect(r.flags).toContain("glossary");
  expect(r.missingGlossary).toContain("Mr. Holloway");
});
