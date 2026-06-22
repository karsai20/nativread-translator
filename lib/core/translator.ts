// Translator interface + the quality-critical chunk translation logic.
//
// Quality strategy (this is the whole point of the tool, and we only have DeepSeek, so
// quality must come from HOW we use it):
//
//   1. Translate a whole multi-paragraph chunk in ONE request, not paragraph-by-
//      paragraph. The model sees a full passage, so tone, pronoun reference, and
//      register stay coherent. Blocks are separated by markers so we can still map each
//      translated paragraph back to its source block.
//   2. Carry rolling continuity context: the tail of the previously translated text is
//      passed in, so voice/register/formality continue seamlessly across chunk seams.
//   3. Carry a names/terms glossary so characters and places stay consistent book-wide.
//   4. Optional second "polish" pass: ask the model to improve its own draft into more
//      natural literary Hungarian. Cheap on DeepSeek, a real quality lever.
//   5. Robust fallback: if the model drops a block marker, re-translate that chunk's
//      blocks individually so output is never lost.

import { merge, unresolvedTerms, type GlossaryMap } from "./glossary";
import {
  protect,
  restore,
  stripInlineTags,
  blockMarker,
  splitBlockSegments,
  BLOCK_MARKER_OPEN,
  BLOCK_MARKER_CLOSE,
} from "./markup";

const BLOCK_MARKER_RE = new RegExp(`${BLOCK_MARKER_OPEN}\\d*${BLOCK_MARKER_CLOSE}?`, "g");

export const SOURCE_LANG = "English";
export const TARGET_LANG = "Hungarian";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TranslateChunkInput {
  /** Multi-block payload: blocks separated by block markers, inline tags tokenized. */
  text: string;
  sourceLang: string;
  targetLang: string;
  glossary: GlossaryMap;
  /** Tail of the previously translated text, for seamless continuity. */
  previousContext?: string;
}

export interface RefineChunkInput {
  /** The tokenized source payload. */
  source: string;
  /** The draft translation to improve. */
  draft: string;
  targetLang: string;
  glossary: GlossaryMap;
  previousContext?: string;
}

export interface TranslateChunkOutput {
  text: string;
  usage?: TokenUsage;
}

export interface ResolveGlossaryInput {
  /** Recurring source terms that need one fixed canonical target rendering. */
  terms: string[];
  targetLang: string;
}

export interface Translator {
  readonly name: string;
  translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput>;
  /** Optional second-pass polish. If absent, refinement is skipped. */
  refineChunk?(input: RefineChunkInput): Promise<TranslateChunkOutput>;
  /**
   * Optional up-front pass: decide ONE canonical target rendering per recurring term so
   * names/objects stay identical across the whole book (not re-derived per chunk).
   * Returns a partial source-term -> target map. If absent, the seeded glossary is used
   * as-is (model keeps consistency only via context).
   */
  resolveGlossary?(input: ResolveGlossaryInput): Promise<GlossaryMap>;
}

/**
 * Resolve the still-empty glossary terms into fixed canonical renderings once, up front,
 * and merge them in. This is what makes a frequently-appearing name or object render the
 * same every time it appears. No-op when the provider can't resolve or nothing is unresolved.
 */
export async function resolveGlossary(
  provider: Translator,
  glossary: GlossaryMap,
  targetLang: string = TARGET_LANG,
  limit = 80,
): Promise<GlossaryMap> {
  if (!provider.resolveGlossary) return glossary;
  const terms = unresolvedTerms(glossary, limit);
  if (terms.length === 0) return glossary;
  const resolved = await provider.resolveGlossary({ terms, targetLang });
  return merge(glossary, resolved);
}

export interface BlockInput {
  index: number;
  innerHtml: string;
}

export interface BlockResult {
  index: number;
  html: string;
}

export interface TranslateBlocksOptions {
  glossary: GlossaryMap;
  previousContext?: string;
  /** Run the second polish pass when the provider supports it. */
  refine?: boolean;
}

export interface TranslateBlocksResult {
  blocks: BlockResult[];
  usage: TokenUsage;
  /** Plain-text rendering of the translated chunk, for the next chunk's continuity. */
  plainText: string;
}

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

function toPlainText(html: string): string {
  return stripInlineTags(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Translate all blocks of a chunk together, with context. Returns the translated inner
 * HTML per block (originals preserved for non-translatable blocks), summed usage, and a
 * plain-text rendering for continuity carry.
 */
export async function translateBlocks(
  provider: Translator,
  blocks: BlockInput[],
  opts: TranslateBlocksOptions,
): Promise<TranslateBlocksResult> {
  const prepared = blocks.map((b) => {
    const { text, tokens } = protect(b.innerHtml);
    return { index: b.index, originalHtml: b.innerHtml, text, tokens };
  });

  const translatable = prepared.filter((p) => p.text.trim().length > 0);

  // Nothing to translate (e.g. image-only blocks): return originals untouched.
  if (translatable.length === 0) {
    return {
      blocks: prepared.map((p) => ({ index: p.index, html: p.originalHtml })),
      usage: EMPTY_USAGE,
      plainText: "",
    };
  }

  const payload = translatable.map((p) => `${blockMarker(p.index)}\n${p.text}`).join("\n\n");

  let usage = EMPTY_USAGE;

  const draft = await provider.translateChunk({
    text: payload,
    sourceLang: SOURCE_LANG,
    targetLang: TARGET_LANG,
    glossary: opts.glossary,
    previousContext: opts.previousContext,
  });
  usage = addUsage(usage, draft.usage);

  let finalText = draft.text;
  if (opts.refine && provider.refineChunk) {
    const refined = await provider.refineChunk({
      source: payload,
      draft: draft.text,
      targetLang: TARGET_LANG,
      glossary: opts.glossary,
      previousContext: opts.previousContext,
    });
    usage = addUsage(usage, refined.usage);
    finalText = refined.text;
  }

  const segments = splitBlockSegments(finalText);
  const byIndex = new Map(segments.map((s) => [s.index, s.body.trim()]));
  const allPresent = translatable.every((p) => (byIndex.get(p.index)?.length ?? 0) > 0);

  if (allPresent) {
    const out = prepared.map((p) => {
      if (p.text.trim().length === 0) return { index: p.index, html: p.originalHtml };
      return { index: p.index, html: restore(byIndex.get(p.index)!, p.tokens) };
    });
    return { blocks: out, usage, plainText: out.map((b) => toPlainText(b.html)).join("\n") };
  }

  // Fallback: a marker went missing. Translate each block on its own so nothing is lost.
  const fallback = await translateBlocksIndividually(provider, prepared, opts);
  return { blocks: fallback.blocks, usage: addUsage(usage, fallback.usage), plainText: fallback.plainText };
}

async function translateBlocksIndividually(
  provider: Translator,
  prepared: { index: number; originalHtml: string; text: string; tokens: string[] }[],
  opts: TranslateBlocksOptions,
): Promise<TranslateBlocksResult> {
  let usage = EMPTY_USAGE;
  const out: BlockResult[] = [];

  for (const p of prepared) {
    if (p.text.trim().length === 0) {
      out.push({ index: p.index, html: p.originalHtml });
      continue;
    }
    const res = await provider.translateChunk({
      text: p.text,
      sourceLang: SOURCE_LANG,
      targetLang: TARGET_LANG,
      glossary: opts.glossary,
      previousContext: opts.previousContext,
    });
    usage = addUsage(usage, res.usage);
    // Strip any stray block markers the model may have echoed, then restore tags.
    const cleaned = res.text.replace(BLOCK_MARKER_RE, "").trim();
    out.push({ index: p.index, html: restore(cleaned, p.tokens) });
  }

  return { blocks: out, usage, plainText: out.map((b) => toPlainText(b.html)).join("\n") };
}
