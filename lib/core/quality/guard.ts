// Blocking output guard. Unlike the soft validators (which only gate the refine pass),
// the guard catches the failures that, in production, got baked straight into the book:
//   - the model REFUSING to translate ("Sorry, I can't ...");
//   - the model leaking its chain-of-thought, sometimes in another language (CJK);
//   - the source language left in place, untranslated (token-salad at high temperature);
//   - a placeholder sentinel that survived into the final text (token corruption).
// A guard failure makes the caller re-translate the chunk deterministically and, if it
// still fails, drop the chunk (per-chunk isolation) rather than emit garbage.

import { hasResidualSentinel } from "../markup";
import {
  DEFAULT_PAIR,
  LANGUAGES,
  distinctStopwords,
  type LanguagePair,
} from "../languages";

export type GuardReason = "refusal" | "foreign" | "untranslated" | "residual";

export interface GuardBlock {
  index: number;
  sourcePlain: string;
  targetHtml: string;
  targetPlain: string;
}

export interface GuardReport {
  ok: boolean;
  reasons: { index: number; reason: GuardReason }[];
}

// Only inspect blocks with enough source text that an untranslated result is meaningful.
const MIN_TEXT = 40;

// Three or more distinct function words is what separates "a sentence that
// happens to share a word" from "this passage is in that language".
const LANGUAGE_HITS = 3;

const REFUSAL_RE =
  /\b(sorry,? i can'?t|i cannot translate|i can'?t generate|i'?m unable to|as an ai|i am an ai|cannot provide a translation|keep every token)\b/i;

// Hiragana, Katakana, CJK Unified Ideographs (deliberately excludes the \u3010\u3011
// block-marker bracket range, which is not a sign of foreign output).
const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff]/;

/**
 * Did the model hand back the source language instead of translating it?
 *
 * Generalised from the original English-source/Hungarian-target test: a passage
 * counts as untranslated when it reads as the source language, carries none of
 * the target's distinctive characters, and does not read as the target either.
 * The last condition is new and only ever makes the guard *less* trigger-happy —
 * a real translation that shares function words with its source still passes.
 */
function looksUntranslated(text: string, pair: LanguagePair): boolean {
  if (pair.source === pair.target) return false;
  if (distinctStopwords(text, pair.source) < LANGUAGE_HITS) return false;
  if (LANGUAGES[pair.target].distinctiveChars?.test(text)) return false;
  return distinctStopwords(text, pair.target) < LANGUAGE_HITS;
}

function reasonFor(b: GuardBlock, pair: LanguagePair): GuardReason | undefined {
  if (hasResidualSentinel(b.targetHtml)) return "residual";

  const text = b.targetPlain.trim();
  if (REFUSAL_RE.test(text)) return "refusal";
  // Stray CJK means a leaked chain of thought — unless CJK is the target.
  if (LANGUAGES[pair.target].script !== "cjk" && CJK_RE.test(text)) return "foreign";

  if (b.sourcePlain.trim().length >= MIN_TEXT && text.length >= MIN_TEXT) {
    if (looksUntranslated(text, pair)) return "untranslated";
  }
  return undefined;
}

export function guardChunk(
  blocks: GuardBlock[],
  pair: LanguagePair = DEFAULT_PAIR,
): GuardReport {
  const reasons: { index: number; reason: GuardReason }[] = [];
  for (const b of blocks) {
    const reason = reasonFor(b, pair);
    if (reason) reasons.push({ index: b.index, reason });
  }
  return { ok: reasons.length === 0, reasons };
}
