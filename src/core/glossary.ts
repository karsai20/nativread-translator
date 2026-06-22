// Glossary: names and terms carried across chunks so the whole book stays
// consistent (a character named "Mr. Holloway" should not become three different
// Hungarian renderings across chapters).
//
// v1 strategy, kept deliberately simple and portable:
//   - Seed candidate proper nouns from the source text (capitalized multi-word runs
//     and repeated capitalized single words).
//   - Pass the current glossary into every chunk's prompt so the model is told which
//     fixed translations to reuse.
//   - Merge any author-confirmed/known mappings forward.
//
// The map is source-term -> target-term. An empty target means "known proper noun,
// keep it consistent" (the model is told to pick one rendering and stick to it).

import { stripInlineTags } from "./markup.ts";

export type GlossaryMap = Record<string, string>;

// A capitalized word, optionally followed by more capitalized words (e.g. "New York",
// "Mr. Holloway"). Excludes all-caps shouting and single common sentence-initial words
// via the frequency filter below.
const PROPER_NOUN_RE =
  /\b([A-Z][a-z]+(?:\.?\s+(?:[A-Z][a-z]+|[A-Z]\.))*)\b/g;

const MIN_OCCURRENCES = 2;
const MAX_SEEDED_TERMS = 200;

/** Heuristically seed candidate proper nouns from raw spine-item XHTML. */
export function seedFromText(xhtml: string, into: GlossaryMap = {}): GlossaryMap {
  const text = stripInlineTags(xhtml).replace(/<[^>]+>/g, " ");
  const counts = new Map<string, number>();

  for (const match of text.matchAll(PROPER_NOUN_RE)) {
    const term = match[1]?.trim();
    if (!term) continue;
    // Multi-word names are kept even on first sight; single words need repetition
    // so we don't capture every sentence-initial "The"/"She".
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  const result: GlossaryMap = { ...into };
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [term, count] of sorted) {
    if (Object.keys(result).length >= MAX_SEEDED_TERMS) break;
    const isMultiWord = term.includes(" ");
    if (!isMultiWord && count < MIN_OCCURRENCES) continue;
    if (!(term in result)) result[term] = "";
  }

  return result;
}

/** Merge two glossaries; non-empty target translations win over empty ones. */
export function merge(base: GlossaryMap, incoming: GlossaryMap): GlossaryMap {
  const result: GlossaryMap = { ...base };
  for (const [term, target] of Object.entries(incoming)) {
    if (target) result[term] = target;
    else if (!(term in result)) result[term] = "";
  }
  return result;
}

/** Render the glossary as a compact instruction block for the translation prompt. */
export function formatForPrompt(glossary: GlossaryMap): string {
  const entries = Object.entries(glossary);
  if (entries.length === 0) return "";

  const lines = entries.map(([term, target]) =>
    target ? `- "${term}" -> "${target}"` : `- "${term}" (keep one consistent rendering)`,
  );
  return [
    "Maintain consistent translations for these names/terms across the whole book:",
    ...lines,
  ].join("\n");
}
