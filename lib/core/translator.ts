// Translator interface + the quality-critical chunk translation logic.
//
// Quality strategy (this is the whole point of the tool, independent of provider):
//
//   1. Translate a whole multi-paragraph chunk in ONE request, not paragraph-by-
//      paragraph. The model sees a full passage, so tone, pronoun reference, and
//      register stay coherent. Blocks are separated by markers so we can still map each
//      translated paragraph back to its source block.
//   2. Carry rolling continuity context: the tail of the previously translated text is
//      passed in, so voice/register/formality continue seamlessly across chunk seams.
//   3. Carry a names/terms glossary so characters and places stay consistent book-wide.
//   4. Optional second "polish" pass: ask the model to improve its own draft into more
//      natural literary Hungarian.
//   5. Robust fallback: if the model drops a block marker, re-translate that chunk's
//      blocks individually so output is never lost.
//   6. Blocking guard: a draft that REFUSES, leaks chain-of-thought / foreign text, or
//      left placeholder garbage is re-translated deterministically and, if still bad,
//      fails the chunk (per-chunk isolation) rather than baking garbage into the book.

import { parse } from "node-html-parser";

import type { GlossaryMap } from "./glossary";
import {
  stripInlineTags,
  blockMarker,
  joinBlockSegments,
  splitBlockSegments,
  BLOCK_MARKER_OPEN,
  BLOCK_MARKER_CLOSE,
} from "./markup";
import { protectHtmlTextNodes, type ProtectedHtmlText } from "./html-segments";
import { validateChunk, type QualityFlag, type ValidateOptions } from "./quality/validators";
import { routeDraft, MAX_QUALITY_ITERATIONS, type PrecisionMode } from "./quality/route";
import { guardChunk, type GuardReason } from "./quality/guard";

const BLOCK_MARKER_RE = new RegExp(`${BLOCK_MARKER_OPEN}\\d*${BLOCK_MARKER_CLOSE}?`, "g");

export const SOURCE_LANG = "English";
export const TARGET_LANG = "Hungarian";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Portion of inputTokens that a provider served from context cache, when reported.
   */
  cachedInputTokens?: number;
}

export interface TranslateChunkInput {
  /** Multi-block payload: blocks separated by block markers, text nodes marked. */
  text: string;
  sourceLang: string;
  targetLang: string;
  glossary: GlossaryMap;
  /** Tail of the previously translated text, for seamless continuity. */
  previousContext?: string;
  /**
   * Tail of the SOURCE text immediately preceding this chunk. Unlike previousContext it
   * needs no translated predecessor, so it survives full chunk-level parallelism — it is
   * what tells the model who "he" refers to across a chunk seam.
   */
  sourceContext?: string;
  /**
   * Force deterministic decoding (temperature 0). Used by the guard's retry: when a draft
   * was rejected, a temp-0 re-translation is far less likely to repeat a degenerate result.
   */
  deterministic?: boolean;
}

/**
 * What is actually wrong with the draft, as far as the validators and the judge can tell.
 * The pipeline computes this to DECIDE on a refine; passing it along makes the second pass
 * targeted ("these names are missing") instead of a blind re-polish.
 */
export interface RefineDiagnosis {
  flags: QualityFlag[];
  /** Glossary terms present in the source whose agreed rendering is absent from the draft. */
  missingGlossary: string[];
  omission?: boolean;
  accuracy?: boolean;
  fluency?: boolean;
}

export interface RefineChunkInput {
  /** The tokenized source payload. */
  source: string;
  /** The draft translation to improve. */
  draft: string;
  targetLang: string;
  glossary: GlossaryMap;
  previousContext?: string;
  /** Escalate this refine to a slower reasoning model (for the hardest passages). */
  deep?: boolean;
  /** Known defects, so the editor pass knows what to look for. */
  diagnosis?: RefineDiagnosis;
}

export interface TranslateChunkOutput {
  text: string;
  usage?: TokenUsage;
}

export interface EstimateChunkInput {
  /** The tokenized source payload. */
  source: string;
  /** The draft translation to judge. */
  draft: string;
  targetLang: string;
  glossary: GlossaryMap;
}

export interface EstimateChunkOutput {
  /** Whether the draft is weak enough to warrant a refine pass. */
  needsRefine: boolean;
  /** Whether the draft is weak enough to warrant the slower reasoning model. */
  hard?: boolean;
  /** 1–5 quality score when the provider produced one (5 = publishable as-is). */
  score?: number;
  /** Judge flag: source content is missing/untranslated. */
  omission?: boolean;
  /** Judge flag: meaning is wrong or invented. */
  accuracy?: boolean;
  /** Judge flag: reads awkward/unnatural in the target language. */
  fluency?: boolean;
  /**
   * Block indices the judge considers weak. Lets the refine pass regenerate only those
   * blocks — output tokens are ~85% of a chunk's cost, so re-emitting clean paragraphs
   * is the single most wasteful thing the pipeline can do.
   */
  weakBlocks?: number[];
  usage?: TokenUsage;
}

export interface FillGlossaryInput {
  /** Source terms whose target-language rendering is not decided yet. */
  terms: string[];
  targetLang: string;
}

export interface FillGlossaryOutput {
  /** Source term -> the rendering to use for the whole book. */
  glossary: GlossaryMap;
  usage?: TokenUsage;
}

export interface Translator {
  readonly name: string;
  translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput>;
  /**
   * Optional one-shot pass that decides each seeded name's rendering BEFORE the book is
   * translated. Without it every chunk decides independently — with hundreds of chunks
   * running in parallel, "Mr. Holloway" becomes "Holloway úr" in one chapter and stays
   * "Mr. Holloway" in the next.
   */
  fillGlossary?(input: FillGlossaryInput): Promise<FillGlossaryOutput>;
  /** Optional second-pass polish. If absent, refinement is skipped. */
  refineChunk?(input: RefineChunkInput): Promise<TranslateChunkOutput>;
  /**
   * Optional cheap quality gate (TEaR "Estimate" step): judges a draft and reports
   * whether it needs the expensive refine pass. Output is tiny, so good drafts skip the
   * full second generation — the bulk of the cost/time saving of selective refinement.
   */
  estimateChunk?(input: EstimateChunkInput): Promise<EstimateChunkOutput>;
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
  /** Source text immediately before this chunk; resolves references across seams. */
  sourceContext?: string;
  /** Run the second polish pass when the provider supports it. */
  refine?: boolean;
  /**
   * Gate the refine pass on a cheap quality estimate (TEaR): only drafts the provider
   * judges weak get refined. Requires the provider to implement estimateChunk; otherwise
   * refinement stays unconditional.
   */
  selectiveRefine?: boolean;
  /**
   * For the hardest drafts (per the estimate), run the refine on a reasoning model.
   * Only takes effect alongside selectiveRefine.
   */
  reasonerForHard?: boolean;
  /** Quality mode; tunes the local validators' length bands and back-translation. */
  precision?: PrecisionMode;
}

/** Thrown when a chunk's translation fails the blocking guard even after a deterministic retry. */
export class TranslationGuardError extends Error {
  readonly reasons: { index: number; reason: GuardReason }[];
  constructor(reasons: { index: number; reason: GuardReason }[]) {
    super(`Translation guard rejected chunk: ${reasons.map((r) => `#${r.index}:${r.reason}`).join(", ")}`);
    this.name = "TranslationGuardError";
    this.reasons = reasons;
  }
}

/**
 * Mode-dependent length-ratio band for the omission check.
 *
 * Calibrated against a measured run (`bun run eval`, 12 chunks x 3 models on a real
 * novel): healthy EN->HU chunks land between 0.91 and 1.04, median 1.00. A chunk that had
 * silently dropped a whole paragraph of dialogue measured 0.85 — and sailed through the
 * old 0.55 floor, which would let a chunk lose 45% of the book and still pass.
 *
 * The floor is the side that matters: a missing paragraph is invisible to the reader who
 * has no source, while over-length only ever costs a wasted refine pass.
 */
function lengthBand(mode: PrecisionMode | undefined): ValidateOptions {
  if (mode === "fidelity") return { minLengthRatio: 0.92, maxLengthRatio: 1.25 };
  return { minLengthRatio: 0.88, maxLengthRatio: 1.45 };
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
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}

/** Inner HTML -> readable text: drops markup tokens and tags, collapses whitespace. */
export function toPlainText(html: string): string {
  const withoutMarkup = stripInlineTags(html).replace(/<[^>]+>/g, " ");
  return parse(withoutMarkup).text
    .replace(/\s+/g, " ")
    .trim();
}

interface Prepared {
  index: number;
  originalHtml: string;
  text: string;
  html: ProtectedHtmlText;
}

/** Build the guard's view of a finished chunk: source vs translated plain text per block. */
function guardBlocks(prepared: Prepared[], out: BlockResult[]) {
  const byIndex = new Map(out.map((b) => [b.index, b.html]));
  return prepared
    .filter((p) => p.text.trim().length > 0)
    .map((p) => {
      const html = byIndex.get(p.index) ?? "";
      return { index: p.index, sourcePlain: toPlainText(p.originalHtml), targetHtml: html, targetPlain: toPlainText(html) };
    });
}

/**
 * Translate all blocks of a chunk together, with context. Returns the translated inner
 * HTML per block (originals preserved for non-translatable blocks), summed usage, and a
 * plain-text rendering for continuity carry.
 *
 * A draft that fails the blocking guard is re-translated deterministically; if it still
 * fails, this throws TranslationGuardError so the caller can drop the chunk.
 */
export async function translateBlocks(
  provider: Translator,
  blocks: BlockInput[],
  opts: TranslateBlocksOptions,
): Promise<TranslateBlocksResult> {
  const prepared: Prepared[] = blocks.map((b) => {
    const html = protectHtmlTextNodes(b.innerHtml);
    return { index: b.index, originalHtml: b.innerHtml, text: html.text, html };
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

  // First pass: full pipeline (draft + optional refine).
  const first = await produceBlocks(provider, prepared, translatable, opts, { deterministic: false, refine: opts.refine });
  if (guardChunk(guardBlocks(prepared, first.blocks)).ok) return first;

  // Guard rejected the draft. Retry once, deterministically and without the refine pass —
  // a temp-0 re-translation rarely repeats a refusal / degenerate / foreign result.
  const retry = await produceBlocks(provider, prepared, translatable, opts, { deterministic: true, refine: false });
  const report = guardChunk(guardBlocks(prepared, retry.blocks));
  if (report.ok) return { ...retry, usage: addUsage(first.usage, retry.usage) };

  // Still bad: fail the chunk so per-chunk isolation drops it (no garbage in the book).
  throw new TranslationGuardError(report.reasons);
}

interface ProduceControl {
  deterministic: boolean;
  refine?: boolean;
}

/**
 * Narrow a refine pass to the blocks the judge flagged. Returns undefined — meaning
 * "refine the whole chunk" — whenever scoping would be unsafe: no flagged blocks, a
 * draft that no longer splits into the expected blocks, or a flag set that covers
 * everything anyway.
 */
function scopeToWeakBlocks(
  sourcePayload: string,
  draft: string,
  weakBlocks: number[] | undefined,
): { source: string; draft: string } | undefined {
  if (!weakBlocks || weakBlocks.length === 0) return undefined;

  const sourceSegments = splitBlockSegments(sourcePayload);
  const draftSegments = splitBlockSegments(draft);
  if (sourceSegments.length === 0 || draftSegments.length !== sourceSegments.length) return undefined;

  const wanted = new Set(weakBlocks);
  const source = sourceSegments.filter((s) => wanted.has(s.index));
  const scopedDraft = draftSegments.filter((s) => wanted.has(s.index));
  if (source.length === 0 || source.length !== scopedDraft.length) return undefined;
  if (source.length === sourceSegments.length) return undefined; // everything is weak

  return { source: joinBlockSegments(source), draft: joinBlockSegments(scopedDraft) };
}

/**
 * Replace the refined blocks inside the full draft, keeping every block the refine pass
 * did not return. A refine that mangled its markers therefore costs us nothing but the
 * tokens — the original blocks stay.
 */
function spliceBlocks(fullDraft: string, refinedSubset: string): string {
  const refined = new Map(splitBlockSegments(refinedSubset).map((s) => [s.index, s.body.trim()]));
  if (refined.size === 0) return fullDraft;
  const merged = splitBlockSegments(fullDraft).map((s) => {
    const replacement = refined.get(s.index);
    return replacement ? { index: s.index, body: replacement } : s;
  });
  return joinBlockSegments(merged);
}

/** One full attempt at a chunk: draft, optional refine, split, restore (with marker fallback). */
async function produceBlocks(
  provider: Translator,
  prepared: Prepared[],
  translatable: Prepared[],
  opts: TranslateBlocksOptions,
  ctl: ProduceControl,
): Promise<TranslateBlocksResult> {
  const payload = translatable.map((p) => `${blockMarker(p.index)}\n${p.text}`).join("\n\n");

  let usage = EMPTY_USAGE;

  const draft = await provider.translateChunk({
    text: payload,
    sourceLang: SOURCE_LANG,
    targetLang: TARGET_LANG,
    glossary: opts.glossary,
    previousContext: opts.previousContext,
    sourceContext: opts.sourceContext,
    deterministic: ctl.deterministic,
  });
  usage = addUsage(usage, draft.usage);

  let finalText = draft.text;
  if (ctl.refine && provider.refineChunk) {
    if (!opts.selectiveRefine) {
      // Legacy unconditional refine: one polish pass, no quality gate.
      const refined = await provider.refineChunk({
        source: payload,
        draft: finalText,
        targetLang: TARGET_LANG,
        glossary: opts.glossary,
        previousContext: opts.previousContext,
        deep: false,
      });
      usage = addUsage(usage, refined.usage);
      finalText = refined.text;
    } else {
      // Adaptive pipeline: local validators + judge -> routed, bounded refinement.
      const mode: PrecisionMode = opts.precision ?? "balanced";
      const band = lengthBand(mode);

      for (let iteration = 0; iteration < MAX_QUALITY_ITERATIONS; iteration++) {
        const local = validateChunk(
          {
            sourcePlain: toPlainText(payload),
            targetPlain: toPlainText(finalText),
            sourceTokenized: payload,
            targetTokenized: finalText,
            glossary: opts.glossary,
          },
          band,
        );

        // The judge is a paid call that only feeds routeDraft. A local omission flag
        // already routes to the maximum action (deep refine), which no verdict can
        // escalate further — so buying a verdict there changes nothing. Minor flags
        // still ask the judge, since it can upgrade them to a deep refine.
        let verdict;
        if (provider.estimateChunk && !local.flags.includes("omission")) {
          try {
            verdict = await provider.estimateChunk({
              source: payload,
              draft: finalText,
              targetLang: TARGET_LANG,
              glossary: opts.glossary,
            });
            usage = addUsage(usage, verdict.usage);
          } catch {
            verdict = undefined;
          }
        }

        const decision = routeDraft({ local, verdict, mode, iteration });
        if (decision.action === "accept") break;

        const diagnosis: RefineDiagnosis = {
          flags: local.flags,
          missingGlossary: local.missingGlossary,
          ...(verdict?.omission ? { omission: true } : {}),
          ...(verdict?.accuracy ? { accuracy: true } : {}),
          ...(verdict?.fluency ? { fluency: true } : {}),
        };
        // Regenerate only the blocks the judge called out, when it named any and the
        // draft still splits cleanly; otherwise polish the whole chunk as before.
        const scope = scopeToWeakBlocks(payload, finalText, verdict?.weakBlocks);

        const refined = await provider.refineChunk({
          source: scope?.source ?? payload,
          draft: scope?.draft ?? finalText,
          targetLang: TARGET_LANG,
          glossary: opts.glossary,
          previousContext: opts.previousContext,
          deep: decision.deep && Boolean(opts.reasonerForHard),
          diagnosis,
        });
        usage = addUsage(usage, refined.usage);
        finalText = scope ? spliceBlocks(finalText, refined.text) : refined.text;
      }
    }
  }

  const segments = splitBlockSegments(finalText);
  const byIndex = new Map(segments.map((s) => [s.index, s.body.trim()]));
  const allPresent = translatable.every((p) => (byIndex.get(p.index)?.length ?? 0) > 0);

  if (allPresent) {
    const out: BlockResult[] = [];
    let restoreFailed = false;
    for (const p of prepared) {
      if (p.text.trim().length === 0) {
        out.push({ index: p.index, html: p.originalHtml });
        continue;
      }
      const html = p.html.restore(byIndex.get(p.index)!);
      if (html === undefined) {
        restoreFailed = true;
        break;
      }
      out.push({ index: p.index, html });
    }
    if (!restoreFailed) return { blocks: out, usage, plainText: out.map((b) => toPlainText(b.html)).join("\n") };
  }

  // Fallback: a block or text-node marker went missing. Translate more narrowly so nothing is lost.
  const fallback = await translateBlocksIndividually(provider, prepared, opts, ctl.deterministic);
  return { blocks: fallback.blocks, usage: addUsage(usage, fallback.usage), plainText: fallback.plainText };
}

async function translateBlocksIndividually(
  provider: Translator,
  prepared: Prepared[],
  opts: TranslateBlocksOptions,
  deterministic: boolean,
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
      sourceContext: opts.sourceContext,
      deterministic,
    });
    usage = addUsage(usage, res.usage);
    // Strip any stray block markers the model may have echoed, then restore tags.
    const cleaned = res.text.replace(BLOCK_MARKER_RE, "").trim();
    const html = p.html.restore(cleaned);
    if (html !== undefined) {
      out.push({ index: p.index, html });
      continue;
    }

    const individual = await translateTextSegmentsIndividually(provider, p, opts, deterministic);
    usage = addUsage(usage, individual.usage);
    out.push({ index: p.index, html: individual.html });
  }

  return { blocks: out, usage, plainText: out.map((b) => toPlainText(b.html)).join("\n") };
}

async function translateTextSegmentsIndividually(
  provider: Translator,
  prepared: Prepared,
  opts: TranslateBlocksOptions,
  deterministic: boolean,
): Promise<{ html: string; usage: TokenUsage }> {
  let usage = EMPTY_USAGE;
  const translations = new Map<number, string>();

  for (const segment of prepared.html.segments) {
    const res = await provider.translateChunk({
      text: segment.text,
      sourceLang: SOURCE_LANG,
      targetLang: TARGET_LANG,
      glossary: opts.glossary,
      previousContext: opts.previousContext,
      sourceContext: opts.sourceContext,
      deterministic,
    });
    usage = addUsage(usage, res.usage);
    translations.set(segment.index, res.text);
  }

  return {
    html: prepared.html.restoreFromSegments(translations),
    usage,
  };
}
