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
import { translateBlocks, type Translator } from "./translator";
import { seedFromText, type GlossaryMap } from "./glossary";
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
  words: number;
  spineItemCount: number;
  chunks: { total: number; done: number };
  cost: CostState;
  error?: string;
  /** ISO timestamps. Optional so manifests written before this feature still parse. */
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Durations (ms) of the most recent translated chunks, newest last, capped. */
  chunkDurationsMs?: number[];
  /** Effective parallel worker count, so ETA reflects parallelism (not sequential). */
  concurrency?: number;
  /** True when only the leading fraction of the book was translated (cheap preview). */
  sample?: boolean;
  /** Quality mode used for this job. */
  precision?: PrecisionMode;
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

/**
 * Keep the leading chunks whose cumulative source size covers `fraction` of the book.
 * Always keeps at least one chunk so a sample is never empty.
 */
function takeLeadingFraction(chunks: Chunk[], fraction: number): Chunk[] {
  const chars = chunks.map((c) => c.blocks.reduce((n, b) => n + b.innerHtml.length, 0));
  const total = chars.reduce((a, b) => a + b, 0);
  if (total === 0) return chunks.slice(0, 1);
  const target = total * fraction;
  const kept: Chunk[] = [];
  let acc = 0;
  for (let i = 0; i < chunks.length; i++) {
    kept.push(chunks[i]!);
    acc += chars[i]!;
    if (acc >= target) break;
  }
  return kept;
}

export interface RunJobOptions {
  id: string;
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
  /**
   * Translate only the leading `sampleFraction` (0–1) of the book — a cheap preview to
   * judge translation quality before paying for the whole thing. The rest of the book is
   * left as the original text. Resume-safe: chunk keys are unchanged.
   */
  sampleFraction?: number;
  /** Chapters translated in parallel. Defaults to DEFAULT_CONCURRENCY. */
  concurrency?: number;
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
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as JobState) : undefined;
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

  mkdirSync(join(jobDir, "chunks"), { recursive: true });

  const epub = parseEpub(epubBytes);

  let glossary: GlossaryMap = {};
  for (const item of epub.spine) glossary = seedFromText(item.content, glossary);

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

  // Sample mode: translate only the leading fraction; the rest stays original. Chunks not
  // in scope are simply never translated, so re-stitch leaves their blocks untouched.
  const sampleFraction = opts.sampleFraction;
  const isSample = typeof sampleFraction === "number" && sampleFraction > 0 && sampleFraction < 1;
  const allChunks: Chunk[] = isSample ? takeLeadingFraction(fullChunks, sampleFraction) : fullChunks;
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
    words: countWords(epub),
    spineItemCount: epub.spine.length,
    chunks: { total: allChunks.length, done: doneAtStart },
    // Default cachedInputTokens for manifests written before cache-aware pricing existed.
    cost: prior?.cost ? { ...createCostState(ceilingUsd), ...prior.cost, ceilingUsd } : createCostState(ceilingUsd),
    createdAt: prior?.createdAt ?? nowIso(),
    startedAt: prior?.startedAt ?? nowIso(),
    chunkDurationsMs: prior?.chunkDurationsMs ?? [],
    precision,
    ...(isSample ? { sample: true } : {}),
  };
  state = persist(jobDir, state, onProgress);

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

  const processChunk = async (chunk: Chunk, anchor: string): Promise<ChunkResult | undefined> => {
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
      const out = await translateBlocks(provider, chunk.blocks, {
        glossary,
        previousContext: anchor || undefined,
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
      console.error(`[job ${id}] chunk ${chunk.key} failed:`, err instanceof Error ? err.message : err);
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
      await processChunk(allChunks[i]!, anchor);
    }
  };

  try {
    // Seed the shared style anchor from the first chunk before fanning out, so every
    // parallel chunk continues the same established voice/register.
    if (allChunks.length > 0) {
      const signal = opts.shouldStop?.();
      if (signal) stopSignal = signal;
      else {
        const firstResult = await processChunk(allChunks[0]!, "");
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
      // Some chunks could not be translated. The good ones are cached, so a resume
      // retries only the missing chunks — no whole-book restart, no double payment.
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
    injectAiMarker(epub, { sourceLang: "en", targetLang: "hu" });
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
