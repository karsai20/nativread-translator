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

  const srcLen = args.sourcePlain.trim().length;
  if (srcLen > 0) {
    const ratio = args.targetPlain.trim().length / srcLen;
    if (ratio < opts.minLengthRatio || ratio > opts.maxLengthRatio) flags.push("omission");
  }

  const missingGlossary: string[] = [];
  for (const [term, target] of Object.entries(args.glossary)) {
    if (!target) continue;
    if (args.sourcePlain.includes(term) && !args.targetPlain.includes(target)) {
      missingGlossary.push(term);
    }
  }
  if (missingGlossary.length > 0) flags.push("glossary");

  return { ok: flags.length === 0, flags, missingGlossary };
}
