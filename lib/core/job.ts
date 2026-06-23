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
import { chunkSpineItem, type Chunk } from "./chunker";
import { translateBlocks, resolveGlossary, type Translator } from "./translator";
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
import { CancelledError } from "./retry";

// "stopped" = user-terminated but resumable: finished chunks stay on disk, so re-running
// the job picks up where it left off and nothing already paid for is re-translated.
export type JobStatus = "pending" | "running" | "done" | "error" | "stopped";

export interface JobState {
  id: string;
  status: JobStatus;
  provider: string;
  title?: string;
  words: number;
  spineItemCount: number;
  chunks: { total: number; done: number };
  cost: CostState;
  error?: string;
}

interface ChunkResult {
  key: string;
  blocks: { index: number; html: string }[];
  /** Plain text of the translated chunk, used to seed the next chunk's continuity. */
  plainText: string;
}

const DEFAULT_CEILING_USD = 10;
const CONTEXT_TAIL_CHARS = 600;

export interface RunJobOptions {
  id: string;
  epubBytes: Uint8Array;
  provider: Translator;
  jobDir: string;
  ceilingUsd?: number;
  /** Run the second polish pass (quality up, ~2x cost/time). */
  refine?: boolean;
  /** If set, the finished book is saved into this household library dir. */
  libraryDir?: string;
  onProgress?: (state: JobState) => void;
  /** Cancellation signal: aborts the in-flight request and stops the job (resumable). */
  signal?: AbortSignal;
}

function chunkFilePath(jobDir: string, key: string): string {
  return join(jobDir, "chunks", `${encodeURIComponent(key)}.json`);
}
function manifestPath(jobDir: string): string {
  return join(jobDir, "manifest.json");
}
function glossaryPath(jobDir: string): string {
  return join(jobDir, "glossary.json");
}

/**
 * Resolve canonical renderings for recurring names/terms ONCE, persist them, and reuse
 * the saved map on resume. This is what keeps a frequently-appearing name identical
 * across the whole book instead of re-derived (and drifting) per chunk.
 */
async function loadOrResolveGlossary(
  jobDir: string,
  provider: Translator,
  seeded: GlossaryMap,
): Promise<GlossaryMap> {
  const p = glossaryPath(jobDir);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as GlossaryMap;
  try {
    const resolved = await resolveGlossary(provider, seeded);
    writeFileSync(p, JSON.stringify(resolved, null, 2));
    return resolved;
  } catch {
    // Glossary resolution is a best-effort quality enhancement, not a hard requirement.
    // If the provider is unreachable, translate with the seeded glossary rather than
    // aborting the whole book; do NOT persist, so a later run retries the resolution.
    return seeded;
  }
}
function writeManifest(jobDir: string, state: JobState): void {
  writeFileSync(manifestPath(jobDir), JSON.stringify(state, null, 2));
}
export function readManifest(jobDir: string): JobState | undefined {
  const p = manifestPath(jobDir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as JobState) : undefined;
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
  // Fix one canonical rendering per recurring term up front (persisted; reused on resume).
  glossary = await loadOrResolveGlossary(jobDir, provider, glossary);

  const parsedByHref = new Map<
    string,
    { doc: ReturnType<typeof chunkSpineItem>["doc"]; blockEls: ReturnType<typeof chunkSpineItem>["blockEls"] }
  >();
  const allChunks: Chunk[] = [];
  for (const item of epub.spine) {
    const { chunks, doc, blockEls } = chunkSpineItem(item.href, item.content);
    parsedByHref.set(item.href, { doc, blockEls });
    allChunks.push(...chunks);
  }

  const doneAtStart = allChunks.filter((c) => existsSync(chunkFilePath(jobDir, c.key))).length;

  let state: JobState = {
    id,
    status: "running",
    provider: provider.name,
    title: epub.title,
    words: countWords(epub),
    spineItemCount: epub.spine.length,
    chunks: { total: allChunks.length, done: doneAtStart },
    cost: createCostState(ceilingUsd),
  };
  writeManifest(jobDir, state);
  onProgress?.(state);

  const results = new Map<string, ChunkResult>();
  let prevTail = "";

  try {
    for (const chunk of allChunks) {
      // Stop cleanly at a chunk boundary if the job was terminated (already-done chunks
      // are persisted, so the job stays resumable).
      if (opts.signal?.aborted) throw new CancelledError();

      const cached = loadChunkResult(jobDir, chunk.key);
      if (cached) {
        results.set(chunk.key, cached);
        prevTail = tail(cached.plainText || prevTail);
        continue;
      }

      const chunkChars = chunk.blocks.reduce((n, b) => n + b.innerHtml.length, 0);
      if (wouldExceedCeiling(state.cost, estimateTokensFromChars(chunkChars))) {
        throw new CostCeilingError(state.cost);
      }

      const { blocks, usage, plainText } = await translateBlocks(provider, chunk.blocks, {
        glossary,
        previousContext: prevTail || undefined,
        refine: opts.refine,
        signal: opts.signal,
      });

      const result: ChunkResult = { key: chunk.key, blocks, plainText };
      saveChunkResult(jobDir, result);
      results.set(chunk.key, result);
      prevTail = tail(plainText || prevTail);

      state = {
        ...state,
        chunks: { ...state.chunks, done: state.chunks.done + 1 },
        cost: addUsage(state.cost, usage),
      };
      writeManifest(jobDir, state);
      onProgress?.(state);
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

    const outBytes = writeEpub(epub, translatedByHref);
    writeFileSync(join(jobDir, "output.epub"), outBytes);

    // Persist into the household library so it is not re-translated.
    if (opts.libraryDir) {
      saveToLibrary({
        libraryDir: opts.libraryDir,
        id,
        title: epub.title ?? "Névtelen könyv",
        sourceHash: hashSource(epubBytes),
        words: state.words,
        costUsd: state.cost.usd,
        epubBytes: outBytes,
      });
    }

    state = { ...state, status: "done" };
    writeManifest(jobDir, state);
    onProgress?.(state);
    return state;
  } catch (err) {
    // A user-requested stop is a normal outcome, not a failure: mark it resumable and
    // return rather than throw, so the caller doesn't log it as a crash.
    if (err instanceof CancelledError) {
      state = { ...state, status: "stopped", error: undefined };
      writeManifest(jobDir, state);
      onProgress?.(state);
      return state;
    }
    state = { ...state, status: "error", error: err instanceof Error ? err.message : String(err) };
    writeManifest(jobDir, state);
    onProgress?.(state);
    throw err;
  }
}
