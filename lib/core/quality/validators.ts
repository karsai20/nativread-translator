// Pure, API-free quality checks on a translated chunk. Cheap signals that catch the
// failures the model itself often misses: dropped placeholders, omitted content, and
// glossary terms that didn't make it into the translation.

import type { GlossaryMap } from "../glossary";
import { PLACEHOLDER_OPEN } from "../markup";

export type QualityFlag = "tokens" | "omission" | "glossary";

export interface LocalReport {
  ok: boolean;
  flags: QualityFlag[];
  missingGlossary: string[];
}

export interface ValidateOptions {
  minLengthRatio: number;
  maxLengthRatio: number;
}

/**
 * Is the agreed rendering actually used in the translation?
 *
 * A plain substring test does not survive Hungarian: the language lengthens a word-final
 * a/e before a suffix, so "Melissa" appears as "Melissával" and "Klee" as "Kleével" —
 * correct usage that a naive check reports as a missing term. Those false misses are not
 * free: each one flags the chunk and buys an unnecessary refine pass.
 */
function mentions(text: string, rendering: string): boolean {
  const haystack = text.toLowerCase();
  const needle = rendering.toLowerCase();
  if (haystack.includes(needle)) return true;
  const lengthened = needle.replace(/a$/, "á").replace(/e$/, "é");
  return lengthened !== needle && haystack.includes(lengthened);
}

function countTokens(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === PLACEHOLDER_OPEN) n++;
  return n;
}

export function validateChunk(
  args: {
    sourcePlain: string;
    targetPlain: string;
    sourceTokenized: string;
    targetTokenized: string;
    glossary: GlossaryMap;
  },
  opts: ValidateOptions,
): LocalReport {
  const flags: QualityFlag[] = [];

  if (countTokens(args.sourceTokenized) !== countTokens(args.targetTokenized)) {
    flags.push("tokens");
  }

  // Below this the ratio is noise, not signal: on a heading or a one-line exchange a
  // handful of characters swings it past any band worth setting for real prose.
  const MIN_RATIO_SOURCE_CHARS = 200;
  const srcLen = args.sourcePlain.trim().length;
  if (srcLen >= MIN_RATIO_SOURCE_CHARS) {
    const ratio = args.targetPlain.trim().length / srcLen;
    if (ratio < opts.minLengthRatio || ratio > opts.maxLengthRatio) flags.push("omission");
  }

  const missingGlossary: string[] = [];
  for (const [term, target] of Object.entries(args.glossary)) {
    if (!target) continue;
    if (args.sourcePlain.includes(term) && !mentions(args.targetPlain, target)) {
      missingGlossary.push(term);
    }
  }
  if (missingGlossary.length > 0) flags.push("glossary");

  return { ok: flags.length === 0, flags, missingGlossary };
}
