// The single source of truth for what the pipeline may translate, and how it
// judges the result. Every language-specific constant that used to be inlined
// (prompt names, the guard's accent test, the length-ratio band) lives here.
//
// Turning a pair on is a one-line edit: flip `validated` in PAIRS. That flag is
// the release gate from the blueprint (§3: a pair ships only after a full-novel
// run plus a native-speaker read), so an unvalidated pair is rejected at the
// API boundary rather than quietly translated at unknown quality.

export type LanguageCode = "en" | "hu" | "de" | "es";

export interface LanguageProfile {
  /** English name, which is what the prompts address the model with. */
  readonly name: string;
  /**
   * Common function words. Three or more distinct hits in a passage is the
   * signal that the text *is* this language — the guard's only way to notice
   * that a chunk came back in the source language, untranslated.
   */
  readonly stopwords: readonly string[];
  /**
   * Characters that only this language (of the ones we handle) uses. Their
   * presence proves the text is not in a plain-ASCII source language, which
   * short-circuits the stopword comparison. Optional: English has none.
   */
  readonly distinctiveChars?: RegExp;
  /**
   * Writing system. The guard treats stray CJK as a model leaking its
   * chain-of-thought — unless CJK is what the reader asked for.
   */
  readonly script: "latin" | "cjk";
}

export const LANGUAGES: Record<LanguageCode, LanguageProfile> = {
  en: {
    name: "English",
    stopwords: [
      "the", "and", "was", "were", "that", "with", "have", "his", "her", "she",
      "you", "this", "from", "they", "what", "when", "there", "would", "could",
      "about", "your",
    ],
    script: "latin",
  },
  hu: {
    name: "Hungarian",
    stopwords: [
      "hogy", "nem", "egy", "volt", "csak", "meg", "már", "még", "mint", "ez",
      "az", "de", "is", "el", "ki", "fel", "van", "lehet", "akkor", "amikor",
    ],
    distinctiveChars: /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/,
    script: "latin",
  },
  de: {
    name: "German",
    stopwords: [
      "der", "die", "das", "und", "nicht", "mit", "sich", "auch", "aber",
      "noch", "schon", "wenn", "dann", "eine", "einen", "war", "haben", "wird",
      "über", "durch",
    ],
    distinctiveChars: /[äöüßÄÖÜ]/,
    script: "latin",
  },
  es: {
    name: "Spanish",
    stopwords: [
      "que", "los", "las", "por", "para", "con", "una", "como", "pero", "más",
      "sus", "este", "esta", "todo", "cuando", "porque", "también", "muy",
      "hasta", "sobre",
    ],
    distinctiveChars: /[áéíóúñ¿¡ÁÉÍÓÚÑ]/,
    script: "latin",
  },
};

export interface LanguagePair {
  readonly source: LanguageCode;
  readonly target: LanguageCode;
}

/** Healthy target/source character-length ratio, per precision mode. */
export interface LengthBand {
  readonly balanced: readonly [number, number];
  readonly fidelity: readonly [number, number];
}

export interface PairPolicy extends LanguagePair {
  /**
   * The release gate. `false` means the pair is wired end to end but has never
   * been through a full-novel run and a native read, so the API refuses it.
   */
  readonly validated: boolean;
  /**
   * Measured band for `en->hu` (`bun run eval`, 12 chunks x 3 models on a real
   * novel: healthy chunks land 0.91–1.04, median 1.00; a chunk that had dropped
   * a paragraph of dialogue measured 0.85). Every other pair carries an
   * estimate from typical text expansion and MUST be re-measured before its
   * `validated` flag is flipped.
   */
  readonly lengthBand: LengthBand;
}

/** Ratios for a pair nobody has measured yet: wide enough not to fail honest
 *  work, tight enough to still catch a chunk that lost a whole paragraph. */
const UNMEASURED: LengthBand = { balanced: [0.85, 1.5], fidelity: [0.9, 1.35] };

export const PAIRS: readonly PairPolicy[] = [
  {
    source: "en",
    target: "hu",
    validated: true,
    lengthBand: { balanced: [0.88, 1.45], fidelity: [0.92, 1.25] },
  },
  // German and Spanish run longer than English; Hungarian and English run
  // shorter than the Romance/Germanic sources. All estimates, all unvalidated.
  { source: "en", target: "de", validated: false, lengthBand: { balanced: [0.95, 1.6], fidelity: [1.0, 1.4] } },
  { source: "en", target: "es", validated: false, lengthBand: { balanced: [0.95, 1.65], fidelity: [1.0, 1.45] } },
  { source: "de", target: "en", validated: false, lengthBand: UNMEASURED },
  { source: "es", target: "en", validated: false, lengthBand: UNMEASURED },
  { source: "hu", target: "en", validated: false, lengthBand: UNMEASURED },
  { source: "de", target: "hu", validated: false, lengthBand: UNMEASURED },
  { source: "es", target: "hu", validated: false, lengthBand: UNMEASURED },
];

/** The pair the pipeline uses when a caller does not name one. */
export const DEFAULT_PAIR: LanguagePair = { source: "en", target: "hu" };

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && value in LANGUAGES;
}

export function languageName(code: string): string {
  return isLanguageCode(code) ? LANGUAGES[code].name : code;
}

export function policyFor(pair: LanguagePair): PairPolicy | undefined {
  return PAIRS.find((p) => p.source === pair.source && p.target === pair.target);
}

/** Pairs the API accepts today. Everything else is 400, not best-effort. */
export function validatedPairs(): readonly PairPolicy[] {
  return PAIRS.filter((p) => p.validated);
}

export function isValidatedPair(pair: LanguagePair): boolean {
  return policyFor(pair)?.validated === true;
}

export function lengthBandFor(
  pair: LanguagePair,
  mode: "balanced" | "fidelity",
): readonly [number, number] {
  return (policyFor(pair)?.lengthBand ?? UNMEASURED)[mode];
}

/**
 * How many distinct stopwords of `code` the text uses. The caller's threshold
 * (3) is what separates "a sentence that happens to share a word" from "this
 * passage is in that language".
 */
export function distinctStopwords(text: string, code: LanguageCode): number {
  const words = LANGUAGES[code].stopwords;
  if (words.length === 0) return 0;
  const hits = text.toLowerCase().match(
    new RegExp(`\\b(${words.join("|")})\\b`, "gi"),
  );
  return hits ? new Set(hits.map((h) => h.toLowerCase())).size : 0;
}
