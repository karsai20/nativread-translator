import { test, expect } from "bun:test";
import { seedFromText, seedFromTexts, merge, formatForPrompt } from "../lib/core/glossary.ts";

test("drops words that are only capitalised because they open a sentence", () => {
  // "He" and "After" never appear capitalised mid-sentence; "Klein" does. That is the
  // whole signal — on a real novel this is the difference between a glossary of
  // characters and 200 entries of "He", "The" and "However".
  const prose =
    "<p>Klein opened the door. He saw Klein again. After that, Klein left. " +
    "He waited for Klein. After Klein returned, the room was dark. After Klein spoke, he nodded.</p>";
  const terms = Object.keys(seedFromTexts([prose]));

  expect(terms).toContain("Klein");
  expect(terms).not.toContain("He");
  expect(terms).not.toContain("After");
  // ...and an opener glued to a name keeps the name, not the glue.
  expect(terms).not.toContain("After Klein");
});

test("seeds book-wide, so later chapters are not locked out by the term budget", () => {
  const early = "<p>Klein met Klein. Klein waited for Klein.</p>";
  const late = "<p>The stranger greeted Audrey. Everyone liked Audrey there.</p>";
  const terms = Object.keys(seedFromTexts([early, late]));

  expect(terms).toContain("Klein");
  expect(terms).toContain("Audrey");
});

test("seeds multi-word proper nouns on first sight", () => {
  const g = seedFromText("<p>Mr. Holloway met Sarah Holloway near New York.</p>");
  expect(Object.keys(g)).toContain("Mr. Holloway");
  expect(Object.keys(g)).toContain("Sarah Holloway");
  expect(Object.keys(g)).toContain("New York");
});

test("does not glue terms across block boundaries or sentences", () => {
  // Heading + paragraph: stripped markup leaves a whitespace run between them.
  const blocks = seedFromText("<h1>Chapter One</h1>\n  <p>Mr. Holloway waited.</p>");
  expect(Object.keys(blocks)).toContain("Mr. Holloway");
  expect(Object.keys(blocks)).not.toContain("Chapter One  \n  Chapter One  Mr. Holloway");
  for (const term of Object.keys(blocks)) expect(term).not.toContain("\n");

  // A sentence boundary between two capitalised words is not a compound name.
  const sentences = seedFromText("<p>They sailed to London. Sarah Holloway waited.</p>");
  expect(Object.keys(sentences)).toContain("Sarah Holloway");
  expect(Object.keys(sentences)).not.toContain("London. Sarah Holloway");
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
