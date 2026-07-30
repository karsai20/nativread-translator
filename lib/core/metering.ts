import { parse } from "node-html-parser";

import { chunkSpineItem } from "./chunker";
import type { Epub } from "./epub";

export const CHARACTERS_PER_CREDIT = 1_000;
export const QUOTE_VERSION = "source-chars-v1";

export interface TranslationQuote {
  version: typeof QUOTE_VERSION;
  sourceCharacters: number;
  requiredCredits: number;
  charactersPerCredit: typeof CHARACTERS_PER_CREDIT;
}

/**
 * Count only prose blocks the translator actually processes. HTML markup,
 * scripts, styles and formatting indentation are excluded. Whitespace inside
 * each visible block is collapsed and Unicode is normalized before counting
 * code points, making the quote deterministic and difficult to game with EPUB
 * formatting alone.
 */
export function countSourceCharacters(epub: Epub): number {
  let total = 0;
  for (const item of epub.spine) {
    const { chunks } = chunkSpineItem(item.href, item.content);
    for (const chunk of chunks) {
      for (const block of chunk.blocks) {
        const visible = parse(block.innerHtml)
          .textContent
          .normalize("NFC")
          .replace(/\s+/gu, " ")
          .trim();
        total += Array.from(visible).length;
      }
    }
  }
  return total;
}

export function quoteForEpub(epub: Epub): TranslationQuote {
  const sourceCharacters = countSourceCharacters(epub);
  return {
    version: QUOTE_VERSION,
    sourceCharacters,
    requiredCredits: sourceCharacters === 0
      ? 0
      : Math.ceil(sourceCharacters / CHARACTERS_PER_CREDIT),
    charactersPerCredit: CHARACTERS_PER_CREDIT,
  };
}
