import { test, expect } from "bun:test";
import {
  seedFromText,
  merge,
  formatForPrompt,
  unresolvedTerms,
  parseGlossaryResolution,
} from "../lib/core/glossary.ts";

test("seeds multi-word proper nouns on first sight", () => {
  const g = seedFromText("<p>Mr. Holloway met Sarah Holloway near New York.</p>");
  expect(Object.keys(g)).toContain("Mr. Holloway");
  expect(Object.keys(g)).toContain("Sarah Holloway");
  expect(Object.keys(g)).toContain("New York");
});

test("requires repetition for single-word candidates", () => {
  const once = seedFromText("<p>Boston is nice.</p>");
  expect(Object.keys(once)).not.toContain("Boston");

  const twice = seedFromText("<p>Boston is nice. I love Boston.</p>");
  expect(Object.keys(twice)).toContain("Boston");
});

test("merge keeps non-empty target translations", () => {
  const merged = merge({ "Mr. Holloway": "" }, { "Mr. Holloway": "Holloway úr" });
  expect(merged["Mr. Holloway"]).toBe("Holloway úr");
});

test("formatForPrompt renders both confirmed and to-keep terms", () => {
  const out = formatForPrompt({ "Sarah Holloway": "", "Mr. Holloway": "Holloway úr" });
  expect(out).toContain('"Mr. Holloway" -> "Holloway úr"');
  expect(out).toContain("Sarah Holloway");
});

test("formatForPrompt is empty for an empty glossary", () => {
  expect(formatForPrompt({})).toBe("");
});

test("unresolvedTerms returns only terms with no fixed target", () => {
  const terms = unresolvedTerms({ "Sarah Holloway": "", "Mr. Holloway": "Holloway úr", "New York": "" });
  expect(terms).toContain("Sarah Holloway");
  expect(terms).toContain("New York");
  expect(terms).not.toContain("Mr. Holloway");
});

test("parseGlossaryResolution accepts known terms only and tolerates formatting", () => {
  const known = ["Mr. Holloway", "the Dark Forest", "Sarah"];
  const text = [
    `Mr. Holloway -> Holloway úr`,
    `- "the Dark Forest" => "a Sötét Erdő"`,
    `Sarah -> Sarah`, // unchanged name still pinned
    `Hallucinated -> Nope`, // not in known set → dropped
  ].join("\n");
  const g = parseGlossaryResolution(text, known);
  expect(g["Mr. Holloway"]).toBe("Holloway úr");
  expect(g["the Dark Forest"]).toBe("a Sötét Erdő");
  expect(g["Sarah"]).toBe("Sarah");
  expect(g["Hallucinated"]).toBeUndefined();
});
