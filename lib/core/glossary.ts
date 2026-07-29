// Glossary: names and terms carried across chunks so the whole book stays consistent
// (a character named "Mr. Holloway" should not get three different Hungarian renderings
// across chapters). Source-term -> target-term; empty target means "known proper noun,
// keep one consistent rendering" (the model decides, then reuses it via the carried map).

import { stripInlineTags } from "./markup";

export type GlossaryMap = Record<string, string>;

// A candidate is an optional title ("Mr. Holloway"), then capitalised words or initials
// joined by SINGLE spaces. Both restrictions matter: `\s+` would run across paragraph and
// heading boundaries ("Chapter One \n Chapter One Mr. Holloway" as one term), and allowing
// a period inside the join would glue two sentences together ("London. Sarah"). Junk terms
// are no longer harmless — every entry is rendered once and pushed into every chunk prompt.
const PROPER_NOUN_RE =
  /\b((?:(?:Mr|Mrs|Ms|Dr|St|Fr|Prof)\.[ ])?[A-Z][a-z]+(?:[ ](?:[A-Z][a-z]+|[A-Z]\.))*)\b/g;
const MIN_OCCURRENCES = 2;
const MAX_SEEDED_TERMS = 200;
/**
 * A word is not a proper noun just because it is capitalised — most of the time it merely
 * starts a sentence. Real names also appear capitalised mid-sentence; sentence openers
 * essentially never do. On a real novel the two groups sit an order of magnitude apart
 * (Klein 38% mid-sentence, Captain 67%, versus "He" 0.3% and "After" 0%), so the ratio
 * separates them without a hand-maintained stopword list.
 *
 * Seeding runs per spine item, so the evidence is per chapter and the bar has to be low:
 * a name that fails the test in one chapter is still picked up from another, while a
 * sentence opener fails it in every chapter and never enters the glossary at all.
 */
const RATIO_SAMPLE_MIN = 2;
const MIN_MIDSENTENCE_RATIO = 0.15;

const SENTENCE_END_RE = /[.!?…:;"“”‘’«»—–]/;

/** True if this match only got its capital from opening a sentence, line, or block. */
function isSentenceInitial(text: string, at: number): boolean {
  let i = at - 1;
  let sawNewline = false;
  while (i >= 0 && /\s/.test(text[i]!)) {
    if (text[i] === "\n") sawNewline = true;
    i -= 1;
  }
  if (i < 0 || sawNewline) return true;
  return SENTENCE_END_RE.test(text[i]!);
}

/**
 * Seed candidate proper nouns from a whole book at once.
 *
 * Whole book, not chapter by chapter, for two reasons: the sentence-opener test needs
 * book-wide evidence to be decisive, and MAX_SEEDED_TERMS is a book-wide budget — filling
 * it chapter by chapter hands every slot to the opening chapters and locks out every
 * character introduced later.
 */
export function seedFromTexts(xhtmlDocs: string[]): GlossaryMap {
  const counts = new Map<string, number>();
  const midSentence = new Map<string, number>();

  for (const xhtml of xhtmlDocs) {
    const text = stripInlineTags(xhtml).replace(/<[^>]+>/g, " ");
    for (const match of text.matchAll(PROPER_NOUN_RE)) {
      const term = match[1]?.trim();
      if (!term) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
      if (!isSentenceInitial(text, match.index)) {
        midSentence.set(term, (midSentence.get(term) ?? 0) + 1);
      }
    }
  }

  const isOpener = (term: string, count: number): boolean =>
    count >= RATIO_SAMPLE_MIN && (midSentence.get(term) ?? 0) / count < MIN_MIDSENTENCE_RATIO;

  // Words this text only ever capitalises at the start of a sentence. Derived from the
  // text itself, so it needs no vocabulary list and works for any source language.
  const openers = new Set<string>();
  for (const [term, count] of counts) {
    if (!term.includes(" ") && isOpener(term, count)) openers.add(term);
  }

  const result: GlossaryMap = {};
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [term, count] of sorted) {
    if (Object.keys(result).length >= MAX_SEEDED_TERMS) break;
    const isMultiWord = term.includes(" ");
    if (!isMultiWord && count < MIN_OCCURRENCES) continue;
    if (isOpener(term, count)) continue;
    // "With Klein" is a sentence opener glued to a name — keep the name, drop the glue.
    const name = withoutLeadingOpeners(term, openers);
    if (name && !(name in result)) result[name] = "";
  }

  return result;
}

/** Single-document convenience wrapper, merged into an existing glossary. */
export function seedFromText(xhtml: string, into: GlossaryMap = {}): GlossaryMap {
  return merge(into, seedFromTexts([xhtml]));
}

/** Strip leading sentence-opener words from a candidate; undefined if nothing is left. */
function withoutLeadingOpeners(term: string, openers: Set<string>): string | undefined {
  let out = term;
  while (out.includes(" ")) {
    const [first, ...rest] = out.split(" ");
    if (!first || !openers.has(first)) break;
    out = rest.join(" ");
  }
  return /^[A-Z]/.test(out) ? out : undefined;
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
  return ["Maintain consistent translations for these names/terms across the whole book:", ...lines].join("\n");
}
