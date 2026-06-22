// Translator interface + chunk translation contract.
//
// This is the seam the whole pipeline is built on: every provider (real or fake)
// implements `Translator`, and the rest of the core only ever talks to this
// interface. Keeping it tiny and string-based is deliberate — it is the design
// that ports to Swift in Quire Phase 2.

import type { GlossaryMap } from "./glossary.ts";
import { protect, restore } from "./markup.ts";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TranslateChunkInput {
  /** Plain-ish text with inline markup already replaced by placeholder tokens. */
  text: string;
  sourceLang: string;
  targetLang: string;
  /** Names/terms to translate consistently across the whole book. */
  glossary: GlossaryMap;
}

export interface TranslateChunkOutput {
  /** Translated text; every placeholder token from the input must survive verbatim. */
  text: string;
  usage?: TokenUsage;
}

export interface Translator {
  /** Human-readable id for logging/cost (e.g. "deepseek", "fake"). */
  readonly name: string;
  translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput>;
}

export const SOURCE_LANG = "English";
export const TARGET_LANG = "Hungarian";

/**
 * Translate one block of XHTML inner content:
 *   protect inline tags -> provider.translateChunk -> restore inline tags.
 *
 * Returns the translated inner HTML and any token usage the provider reported.
 */
export async function translateInnerHtml(
  provider: Translator,
  innerHtml: string,
  glossary: GlossaryMap,
): Promise<{ html: string; usage?: TokenUsage }> {
  const { text, tokens } = protect(innerHtml);

  // Nothing translatable (e.g. an image-only block) — skip the provider call.
  if (text.trim().length === 0) {
    return { html: innerHtml };
  }

  const out = await provider.translateChunk({
    text,
    sourceLang: SOURCE_LANG,
    targetLang: TARGET_LANG,
    glossary,
  });

  return { html: restore(out.text, tokens), usage: out.usage };
}
