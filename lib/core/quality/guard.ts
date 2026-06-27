// Blocking output guard. Unlike the soft validators (which only gate the refine pass),
// the guard catches the failures that, in production, got baked straight into the book:
//   - the model REFUSING to translate ("Sorry, I can't ...");
//   - the model leaking its chain-of-thought, sometimes in another language (CJK);
//   - degenerate / untranslated English left in place (token-salad at high temperature);
//   - a placeholder sentinel that survived into the final text (token corruption).
// A guard failure makes the caller re-translate the chunk deterministically and, if it
// still fails, drop the chunk (per-chunk isolation) rather than emit garbage.

import { hasResidualSentinel } from "../markup";

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

// Only inspect blocks with enough source text that an English/foreign result is meaningful.
const MIN_TEXT = 40;

const REFUSAL_RE =
  /\b(sorry,? i can'?t|i cannot translate|i can'?t generate|i'?m unable to|as an ai|i am an ai|cannot provide a translation|keep every token)\b/i;

// Hiragana, Katakana, CJK Unified Ideographs (deliberately excludes the 【】 block-marker
// bracket range U+3010/11, which is not a sign of foreign output).
const CJK_RE = /[぀-ヿ一-鿿]/;

const HU_ACCENT_RE = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/;

// Common English function words; 3+ distinct ones in accent-free text signal untranslated EN.
const EN_STOPWORDS = [
  "the", "and", "was", "were", "that", "with", "have", "his", "her", "she", "you",
  "this", "from", "they", "what", "when", "there", "would", "could", "about", "your",
];
const EN_STOPWORD_RE = new RegExp(`\\b(${EN_STOPWORDS.join("|")})\\b`, "gi");

function countDistinctStopwords(s: string): number {
  const hits = s.toLowerCase().match(EN_STOPWORD_RE);
  return hits ? new Set(hits).size : 0;
}

function reasonFor(b: GuardBlock): GuardReason | undefined {
  if (hasResidualSentinel(b.targetHtml)) return "residual";

  const text = b.targetPlain.trim();
  if (REFUSAL_RE.test(text)) return "refusal";
  if (CJK_RE.test(text)) return "foreign";

  // Untranslated / degenerate English: enough text, no Hungarian accents, and clearly English.
  if (b.sourcePlain.trim().length >= MIN_TEXT && text.length >= MIN_TEXT) {
    if (!HU_ACCENT_RE.test(text) && countDistinctStopwords(text) >= 3) return "untranslated";
  }
  return undefined;
}

export function guardChunk(blocks: GuardBlock[]): GuardReport {
  const reasons: { index: number; reason: GuardReason }[] = [];
  for (const b of blocks) {
    const reason = reasonFor(b);
    if (reason) reasons.push({ index: b.index, reason });
  }
  return { ok: reasons.length === 0, reasons };
}
