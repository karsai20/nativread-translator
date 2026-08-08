// Job orchestrator: chunk -> translate (with context) -> re-stitch -> write EPUB,
// resumable, then save into the household library.
//
// Quality-relevant behaviour:
//   - Chunks are translated whole (multi-paragraph) with a rolling continuity tail so
//     voice/register carry across chunk seams (translateBlocks).
//   - A names/terms glossary is seeded from the whole book up front and carried.
// Reliability:
//   - Each translated chunk is persisted under <jobDir>/chunks/, so a killed process
//     resumes and never re-pays. Re-chunking is deterministic; chunk keys are stable.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseEpub, writeEpub, type Epub } from "./epub";
import { injectAiMarker } from "./ai-marker";
import { chunkSpineItem, type Chunk } from "./chunker";
import { translateBlocks, TranslationGuardError, type Translator } from "./translator";
import { DEFAULT_PAIR, languageName, type LanguagePair } from "./languages";
import { merge as mergeGlossary, seedFromTexts, type GlossaryMap } from "./glossary";
import { stripInlineTags } from "./markup";
import {
  createCostState,
  addUsage,
  estimateTokensFromChars,
  wouldExceedCeiling,
  CostCeilingError,
  type CostState,
} from "./cost";
import { saveToLibrary, hashSource } from "./library";
import type { PrecisionMode } from "./quality/route";

export type JobStatus = "pending" | "running" | "done" | "error" | "paused" | "cancelled";

export interface JobState {
  id: string;
  status: JobStatus;
  provider: string;
  title?: string;
  userId?: string;
  sourceHash?: string;
  /** Immutable server quote captured when the source EPUB was uploaded. */
  sourceCharacters?: number;
  requiredCredits?: number;
  quoteVersion?: string;
  words: number;
  spineItemCount: number;
  chunks: { total: number; done: number };
  cost: CostState;
  error?: string;
  /**
   * Machine-readable error class (eng D4 / E3). "moderation_refusal" means the
   * provider deterministically refused content — retrying re-fails identically
   * and re-burns cost, so clients must show non-retry copy and the free-chapter
   * credit is not consumed. Absent for transient failures, which stay retryable.
   */
  errorCode?: "moderation_refusal";
  /** How many chunks the provider refused on content grounds (T15 datum). */
  refusedChunks?: number;
  /** ISO timestamps. Optional so manifests written before this feature still parse. */
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Durations (ms) of the most recent translated chunks, newest last, capped. */
  chunkDurationsMs?: number[];
  /** Effective parallel worker count, so ETA reflects parallelism (not sequential). */
  concurrency?: number;
  /** True when only the first substantial content chapter was translated. */
  sample?: boolean;
  /** Quality mode used for this job. */
  precision?: PrecisionMode;
  /**
   * Book-wide name/term renderings, decided once before translation starts. Persisted so
   * a resumed job keeps the same renderings (and does not pay for the pass twice).
   */
  glossary?: GlossaryMap;
}

interface ChunkResult {
  key: string;
  blocks: { index: number; html: string }[];
  /** Plain text of the translated chunk, used to seed the next chunk's continuity. */
  plainText: string;
}

const DEFAULT_CEILING_USD = 10;
const CONTEXT_TAIL_CHARS = 600;
/** How many recent chunk durations to keep for a responsive ETA. */
const TIMING_WINDOW = 20;
/**
 * How many spine items (chapters) to translate at once. Chunks WITHIN a chapter stay
 * sequential so the rolling continuity tail is preserved where it matters; independent
 * chapters run in parallel, which is the bulk of the speedup on a real book.
 */
const DEFAULT_CONCURRENCY = 4;

const SAMPLE_MIN_CONTENT_WORDS = 250;
const SAMPLE_MAX_WORDS = 5_000;

function chunkWordCount(chunk: Chunk): number {
  const text = chunk.blocks
    .map((block) => stripInlineTags(block.innerHtml).replace(/<[^>]+>/g, " "))
    .join(" ");
  return text.match(/\S+/g)?.length ?? 0;
}

/**
 * Pick the first substantial spine item, skipping cover/title/copyright/TOC
 * fragments, then keep that chapter up to a bounded word cap. The preview now
 * ends at a natural reading boundary instead of an arbitrary percentage.
 */
export function takeFirstContentChapter(
  chunks: Chunk[],
  minContentWords = SAMPLE_MIN_CONTENT_WORDS,
  maxWords = SAMPLE_MAX_WORDS,
): Chunk[] {
  if (chunks.length === 0) return [];

  const chapters = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const chapter = chapters.get(chunk.itemHref) ?? [];
    chapter.push(chunk);
    chapters.set(chunk.itemHref, chapter);
  }

  const ordered = [...chapters.values()];
  const selected =
    ordered.find((chapter) => chapter.reduce((sum, chunk) => sum + chunkWordCount(chunk), 0) >= minContentWords)
    ?? ordered.find((chapter) => chapter.some((chunk) => chunkWordCount(chunk) > 0))
    ?? ordered[0]!;

  const kept: Chunk[] = [];
  let words = 0;
  for (const chunk of selected) {
    const chunkWords = chunkWordCount(chunk);
    if (kept.length > 0 && words + chunkWords > maxWords) break;
    kept.push(chunk);
    words += chunkWords;
  }
  return kept.length > 0 ? kept : selected.slice(0, 1);
}

export interface RunJobOptions {
  id: string;
  /** Languages this book moves between. Defaults to the pipeline's default
   *  pair; the API validates it before a job ever reaches here. */
  pair?: LanguagePair;
  epubBytes: Uint8Array;
  provider: Translator;
  jobDir: string;
  ceilingUsd?: number;
  /** Run the second polish pass (quality up, ~2x cost/time). */
  refine?: boolean;
  /** Gate the refine pass on a per-chunk quality estimate (skip it for strong drafts). */
  selectiveRefine?: boolean;
  /** Refine the hardest chunks on a reasoning model (needs selectiveRefine). */
  reasonerForHard?: boolean;
  /** Quality mode passed to the per-chunk pipeline. */
  precision?: PrecisionMode;
  /** Translate the first substantial content chapter as a bounded preview. */
  sample?: boolean;
  /** Chapters translated in parallel. Defaults to DEFAULT_CONCURRENCY. */
  concurrency?: number;
  /** Model id, used only to price this job's tokens (see priceProfileFor). */
  model?: string;
  /** If set, the finished book is saved into this household library dir. */
  libraryDir?: string;
  onProgress?: (state: JobState) => void;
  /**
   * Polled once per chunk between chunks for a cooperative stop. Returning a signal
   * exits the loop without throwing and without deleting cached chunks, so a paused
   * job resumes (re-run) for free.
   */
  shouldStop?: () => "pause" | "cancel" | undefined;
}

function chunkFilePath(jobDir: string, key: string): string {
  return join(jobDir, "chunks", `${encodeURIComponent(key)}.json`);
}
function manifestPath(jobDir: string): string {
  return join(jobDir, "manifest.json");
}
function writeManifest(jobDir: string, state: JobState): void {
  writeFileSync(manifestPath(jobDir), JSON.stringify(state, null, 2));
}
export function readManifest(jobDir: string): JobState | undefined {
  const p = manifestPath(jobDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as JobState;
  } catch {
    // A corrupt manifest records no owner, so every ownership check must fail
    // closed on it. Throwing here would instead surface as an unhandled 500.
    return undefined;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Stamp updatedAt, persist to disk, and notify — so memory and manifest stay in sync. */
function persist(jobDir: string, state: JobState, onProgress?: (s: JobState) => void): JobState {
  const stamped: JobState = { ...state, updatedAt: nowIso() };
  writeManifest(jobDir, stamped);
  onProgress?.(stamped);
  return stamped;
}

const ENDED_STATUSES: ReadonlySet<JobStatus> = new Set(["done", "error", "cancelled"]);

/** Force a job's status on disk (for control actions on a job that is not running). */
export function setManifestStatus(jobDir: string, status: JobStatus): JobState | undefined {
  const current = readManifest(jobDir);
  if (!current) return undefined;
  const next: JobState = {
    ...current,
    status,
    updatedAt: nowIso(),
    ...(ENDED_STATUSES.has(status) ? { finishedAt: nowIso() } : {}),
  };
  writeManifest(jobDir, next);
  return next;
}
function loadChunkResult(jobDir: string, key: string): ChunkResult | undefined {
  const p = chunkFilePath(jobDir, key);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ChunkResult) : undefined;
}
function saveChunkResult(jobDir: string, r: ChunkResult): void {
  writeFileSync(chunkFilePath(jobDir, r.key), JSON.stringify(r));
}

function tail(s: string): string {
  return s.length <= CONTEXT_TAIL_CHARS ? s : s.slice(-CONTEXT_TAIL_CHARS);
}

function countWords(epub: Epub): number {
  let n = 0;
  for (const item of epub.spine) {
    const text = stripInlineTags(item.content).replace(/<[^>]+>/g, " ");
    const words = text.match(/\S+/g);
    if (words) n += words.length;
  }
  return n;
}

/** Re-attach the original XML prolog/doctype if node-html-parser dropped it. */
function reserialize(originalXhtml: string, serialized: string): string {
  const prolog = originalXhtml.match(/^[\s\S]*?(?=<html\b)/i)?.[0]?.trim();
  if (prolog && !/^\s*<(\?xml|!doctype)/i.test(serialized)) return `${prolog}\n${serialized}`;
  return serialized;
}

export async function runJob(opts: RunJobOptions): Promise<JobState> {
  const { id, epubBytes, provider, jobDir, onProgress } = opts;
  const ceilingUsd = opts.ceilingUsd ?? DEFAULT_CEILING_USD;
  const pair = opts.pair ?? DEFAULT_PAIR;

  mkdirSync(join(jobDir, "chunks"), { recursive: true });

  const epub = parseEpub(epubBytes);

  let glossary: GlossaryMap = seedFromTexts(epub.spine.map((item) => item.content));
  const seededTerms = Object.keys(glossary).length;

  const parsedByHref = new Map<
    string,
    { doc: ReturnType<typeof chunkSpineItem>["doc"]; blockEls: ReturnType<typeof chunkSpineItem>["blockEls"] }
  >();
  const fullChunks: Chunk[] = [];
  for (const item of epub.spine) {
    const { chunks, doc, blockEls } = chunkSpineItem(item.href, item.content);
    parsedByHref.set(item.href, { doc, blockEls });
    fullChunks.push(...chunks);
  }

  // Sample mode: translate the first real content chapter. Chunks outside the
  // selected chapter remain original, so the output EPUB is still structurally complete.
  const isSample = Boolean(opts.sample);
  const allChunks: Chunk[] = isSample ? takeFirstContentChapter(fullChunks) : fullChunks;
  const precision = opts.precision ?? "balanced";

  const doneAtStart = allChunks.filter((c) => existsSync(chunkFilePath(jobDir, c.key))).length;

  // Carry forward identity/cost/timing from a prior run so a resume is cumulative.
  const prior = readManifest(jobDir);

  let state: JobState = {
    id,
    status: "running",
    provider: provider.name,
    title: epub.title,
    ...(prior?.userId ? { userId: prior.userId } : {}),
    sourceHash: prior?.sourceHash ?? hashSource(epubBytes),
    ...(prior?.sourceCharacters !== undefined
      ? { sourceCharacters: prior.sourceCharacters }
      : {}),
    ...(prior?.requiredCredits !== undefined
      ? { requiredCredits: prior.requiredCredits }
      : {}),
    ...(prior?.quoteVersion ? { quoteVersion: prior.quoteVersion } : {}),
    words: countWords(epub),
    spineItemCount: epub.spine.length,
    chunks: { total: allChunks.length, done: doneAtStart },
    // Default cachedInputTokens for manifests written before cache-aware pricing existed.
    cost: prior?.cost
      ? { ...createCostState(ceilingUsd, opts.model), ...prior.cost, ceilingUsd }
      : createCostState(ceilingUsd, opts.model),
    createdAt: prior?.createdAt ?? nowIso(),
    startedAt: prior?.startedAt ?? nowIso(),
    chunkDurationsMs: prior?.chunkDurationsMs ?? [],
    precision,
    ...(isSample ? { sample: true } : {}),
  };
  state = persist(jobDir, state, onProgress);

  // Decide every recurring name's target-language rendering ONCE, before the chunks fan out.
  // Hundreds of parallel chunks cannot agree on "Holloway úr" by themselves.
  if (prior?.glossary) {
    glossary = mergeGlossary(glossary, prior.glossary);
  } else if (provider.fillGlossary && seededTerms > 0) {
    try {
      const filled = await provider.fillGlossary({
        terms: Object.keys(glossary),
        targetLang: languageName(pair.target),
      });
      // The pass owns the final list: a term it leaves out is one it judged not to be a
      // name, and pinning those to a fixed rendering does more harm than leaving them free.
      if (Object.keys(filled.glossary).length > 0) glossary = filled.glossary;
      state = persist(
        jobDir,
        { ...state, glossary, ...(filled.usage ? { cost: addUsage(state.cost, filled.usage) } : {}) },
        onProgress,
      );
    } catch (err) {
      // Falling back to the seeded glossary only costs consistency, never the book.
      console.error(JSON.stringify({
        event: "glossary-fill-failed",
        jobId: id,
        error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown",
      }));
    }
  }

  const results = new Map<string, ChunkResult>();

  // Parallelism is at the CHUNK level (a flat queue), not the chapter level: a book is
  // hundreds of independent units regardless of how few spine items it has, so all of
  // them translate concurrently. The "fixed stuff" is shared read-only by every chunk —
  // the book-wide glossary (names/terms) plus a single style anchor (the translated tail
  // of the first chunk) that replaces the old rolling per-seam tail. A constant anchor
  // also keeps the prompt prefix identical across chunks for providers with prefix caching.
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const workerCount = Math.min(concurrency, Math.max(1, allChunks.length));
  state = persist(jobDir, { ...state, concurrency: workerCount }, onProgress);

  // Shared, cooperative controls. JS is single-threaded, so the synchronous
  // read-modify-write of `state` between awaits is atomic across workers — no locking.
  let stopSignal: "pause" | "cancel" | undefined;
  let ceilingHit = false;
  let failedChunks = 0;
  let refusedChunks = 0;

  /**
   * Plain-text tail of the chunk before this one. The style anchor keeps the voice
   * consistent, but only this tells chunk N who "he" was at the end of chunk N-1 — and
   * unlike a translated tail it is known up front, so it costs the worker pool nothing.
   */
  const sourceContextFor = (i: number): string | undefined => {
    const previous = allChunks[i - 1];
    if (!previous) return undefined;
    const text = previous.blocks
      .map((b) => stripInlineTags(b.innerHtml).replace(/<[^>]+>/g, " "))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text ? tail(text) : undefined;
  };

  const processChunk = async (chunk: Chunk, anchor: string, index: number): Promise<ChunkResult | undefined> => {
    const cached = loadChunkResult(jobDir, chunk.key);
    if (cached) {
      results.set(chunk.key, cached);
      return cached;
    }

    const chunkChars = chunk.blocks.reduce((n, b) => n + b.innerHtml.length, 0);
    if (wouldExceedCeiling(state.cost, estimateTokensFromChars(chunkChars))) {
      ceilingHit = true;
      return undefined;
    }

    const startedMs = Date.now();
    let blocks, usage, plainText;
    try {
      const sourceContext = sourceContextFor(index);
      const out = await translateBlocks(provider, chunk.blocks, {
        pair,
        glossary,
        previousContext: anchor || undefined,
        ...(sourceContext ? { sourceContext } : {}),
        refine: opts.refine,
        selectiveRefine: opts.selectiveRefine,
        reasonerForHard: opts.reasonerForHard,
        precision: opts.precision,
      });
      blocks = out.blocks;
      usage = out.usage;
      plainText = out.plainText;
    } catch (err) {
      // Per-chunk isolation: a chunk that fails after transport retries is left uncached
      // (so resume retries only it) and never aborts the whole book.
      failedChunks += 1;
      // A guard-confirmed refusal is deterministic (it already survived the
      // temp-0 retry inside translateBlocks) — classify it separately so the
      // job can end with non-retry semantics instead of "try again" copy.
      if (err instanceof TranslationGuardError && err.reasons.some((r) => r.reason === "refusal")) {
        refusedChunks += 1;
        console.error(JSON.stringify({
          event: "translation-chunk-refused",
          jobId: id,
          reasons: err.reasons.map((reason) => ({
            index: reason.index,
            reason: reason.reason,
          })),
        }));
      } else {
        console.error(JSON.stringify({
          event: "translation-chunk-failed",
          jobId: id,
          error: err instanceof Error
            ? `${err.name}: ${err.message}`.slice(0, 400)
            : "Unknown error",
        }));
      }
      return undefined;
    }
    const durationMs = Date.now() - startedMs;

    const result: ChunkResult = { key: chunk.key, blocks, plainText };
    saveChunkResult(jobDir, result);
    results.set(chunk.key, result);

    state = {
      ...state,
      chunks: { ...state.chunks, done: state.chunks.done + 1 },
      cost: addUsage(state.cost, usage),
      chunkDurationsMs: [...(state.chunkDurationsMs ?? []), durationMs].slice(-TIMING_WINDOW),
    };
    state = persist(jobDir, state, onProgress);

    return result;
  };

  let anchor = "";
  let nextChunk = 1; // worker pool starts after the anchor chunk

  const worker = async (): Promise<void> => {
    while (true) {
      if (stopSignal || ceilingHit) return;
      // Cooperative stop point, polled once per chunk: a paused job keeps its chunk
      // cache (resumes for free), a cancelled job ends. Neither throws.
      const signal = opts.shouldStop?.();
      if (signal) {
        stopSignal = signal;
        return;
      }
      const i = nextChunk++;
      if (i >= allChunks.length) return;
      await processChunk(allChunks[i]!, anchor, i);
    }
  };

  try {
    // Seed the shared style anchor from the first chunk before fanning out, so every
    // parallel chunk continues the same established voice/register.
    if (allChunks.length > 0) {
      const signal = opts.shouldStop?.();
      if (signal) stopSignal = signal;
      else {
        const firstResult = await processChunk(allChunks[0]!, "", 0);
        if (firstResult) anchor = tail(firstResult.plainText);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (stopSignal) {
      const status: JobStatus = stopSignal === "pause" ? "paused" : "cancelled";
      state = { ...state, status, ...(status === "cancelled" ? { finishedAt: nowIso() } : {}) };
      return persist(jobDir, state, onProgress);
    }
    if (ceilingHit) {
      throw new CostCeilingError(state.cost);
    }
    if (failedChunks > 0) {
      // Refusals are deterministic: a retry re-fails identically while re-burning
      // API cost, so the error is a distinct non-retry class (eng D4 / E3). The
      // client shows "can't be translated" copy and does NOT consume the
      // free-chapter credit; the manifest keeps refusedChunks as the T15 datum.
      if (refusedChunks > 0) {
        state = {
          ...state,
          status: "error",
          errorCode: "moderation_refusal",
          refusedChunks,
          error:
            "Ezt a könyvet (vagy egy részét) a fordítómodell tartalmi okból nem fordítja le. " +
            "Az újrapróbálkozás nem segít; az ingyenes fejezet-keretedet ez nem használja el.",
          finishedAt: nowIso(),
        };
        return persist(jobDir, state, onProgress);
      }
      // Transient failures: the good chunks are cached, so a resume retries only
      // the missing ones — no whole-book restart, no double payment.
      state = {
        ...state,
        status: "error",
        error: `${failedChunks} szakasz fordítása nem sikerült. Indítsd újra a folytatáshoz.`,
        finishedAt: nowIso(),
      };
      return persist(jobDir, state, onProgress);
    }

    // Re-stitch translated inner HTML back into each spine item's blocks.
    const translatedByHref: Record<string, string> = {};
    for (const item of epub.spine) {
      const parsed = parsedByHref.get(item.href);
      if (!parsed) continue;
      for (const chunk of allChunks) {
        if (chunk.itemHref !== item.href) continue;
        const result = results.get(chunk.key);
        if (!result) continue;
        for (const tb of result.blocks) {
          const el = parsed.blockEls[tb.index];
          if (el) el.set_content(tb.html);
        }
      }
      translatedByHref[item.href] = reserialize(item.content, parsed.doc.toString());
    }

    // EU AI Act Art 50(2): every delivered EPUB (full or sample) carries the
    // machine-readable AI marker + colophon. Throws rather than deliver unmarked.
    // The EU AI Act Art 50 marker must name the real pair, not a constant.
    injectAiMarker(epub, { sourceLang: pair.source, targetLang: pair.target });
    const outBytes = writeEpub(epub, translatedByHref);
    writeFileSync(join(jobDir, "output.epub"), outBytes);

    // Persist into the household library. Samples are saved too (so they're findable and
    // readable from the library) but flagged, so they're badged in the UI and excluded
    // from source-hash dedup — a later full upload of the same book still translates.
    if (opts.libraryDir) {
      saveToLibrary({
        libraryDir: opts.libraryDir,
        id,
        title: epub.title ?? "Névtelen könyv",
        sourceHash: state.sourceHash ?? hashSource(epubBytes),
        ...(state.userId ? { userId: state.userId } : {}),
        words: state.words,
        costUsd: state.cost.usd,
        epubBytes: outBytes,
        ...(isSample ? { sample: true } : {}),
      });
    }

    state = { ...state, status: "done", finishedAt: nowIso() };
    return persist(jobDir, state, onProgress);
  } catch (err) {
    state = {
      ...state,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      finishedAt: nowIso(),
    };
    persist(jobDir, state, onProgress);
    throw err;
  }
}
