// Job orchestrator: chunk -> translate -> re-stitch -> write EPUB, resumable.
//
// Resume is the headline requirement: each translated chunk is persisted as it
// completes under `<jobDir>/chunks/`. Re-running runJob with the same jobDir reloads
// finished chunks from disk and only translates the missing ones, so a killed process
// (or a network drop) continues instead of restarting — and never re-pays for work
// already done. Re-chunking is deterministic, so chunk keys are stable across runs.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseEpub, writeEpub, type Epub } from "./epub.ts";
import { chunkSpineItem, type Chunk } from "./chunker.ts";
import { translateInnerHtml, type Translator } from "./translator.ts";
import { seedFromText, type GlossaryMap } from "./glossary.ts";
import {
  createCostState,
  addUsage,
  estimateTokensFromChars,
  wouldExceedCeiling,
  CostCeilingError,
  type CostState,
} from "./cost.ts";

export type JobStatus = "pending" | "running" | "done" | "error";

export interface JobState {
  id: string;
  status: JobStatus;
  provider: string;
  spineItemCount: number;
  chunks: { total: number; done: number };
  cost: CostState;
  error?: string;
}

/** A persisted translated chunk: the translated inner HTML per block index. */
interface ChunkResult {
  key: string;
  blocks: { index: number; html: string }[];
}

const DEFAULT_CEILING_USD = 10;

export interface RunJobOptions {
  id: string;
  epubBytes: Uint8Array;
  provider: Translator;
  jobDir: string;
  ceilingUsd?: number;
  onProgress?: (state: JobState) => void;
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
  const path = manifestPath(jobDir);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as JobState;
}

function loadChunkResult(jobDir: string, key: string): ChunkResult | undefined {
  const path = chunkFilePath(jobDir, key);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ChunkResult;
}

function saveChunkResult(jobDir: string, result: ChunkResult): void {
  writeFileSync(chunkFilePath(jobDir, result.key), JSON.stringify(result));
}

/** Re-attach the original XML prolog/doctype if node-html-parser dropped it. */
function reserialize(originalXhtml: string, serialized: string): string {
  const prologMatch = originalXhtml.match(/^[\s\S]*?(?=<html\b)/i);
  const prolog = prologMatch?.[0]?.trim();
  if (prolog && !/^\s*<(\?xml|!doctype)/i.test(serialized)) {
    return `${prolog}\n${serialized}`;
  }
  return serialized;
}

export async function runJob(opts: RunJobOptions): Promise<JobState> {
  const { id, epubBytes, provider, jobDir, onProgress } = opts;
  const ceilingUsd = opts.ceilingUsd ?? DEFAULT_CEILING_USD;

  mkdirSync(join(jobDir, "chunks"), { recursive: true });

  const epub: Epub = parseEpub(epubBytes);

  // Seed glossary from the whole book up front so names are consistent from chunk 1.
  let glossary: GlossaryMap = {};
  for (const item of epub.spine) glossary = seedFromText(item.content, glossary);

  // Chunk every spine item (deterministic) and remember each item's parsed doc + blocks.
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

  // Count chunks already on disk so resumed progress is accurate from the first tick.
  const doneAtStart = allChunks.filter((c) => existsSync(chunkFilePath(jobDir, c.key))).length;

  let state: JobState = {
    id,
    status: "running",
    provider: provider.name,
    spineItemCount: epub.spine.length,
    chunks: { total: allChunks.length, done: doneAtStart },
    cost: createCostState(ceilingUsd),
  };
  writeManifest(jobDir, state);
  onProgress?.(state);

  // Collected translated chunk results (loaded or freshly translated), for re-stitch.
  const results = new Map<string, ChunkResult>();

  try {
    for (const chunk of allChunks) {
      const cached = loadChunkResult(jobDir, chunk.key);
      if (cached) {
        results.set(chunk.key, cached);
        continue; // resume: already translated, do not re-call the provider
      }

      // Cost guard before spending: estimate this chunk's input tokens.
      const chunkChars = chunk.blocks.reduce((n, b) => n + b.innerHtml.length, 0);
      if (wouldExceedCeiling(state.cost, estimateTokensFromChars(chunkChars))) {
        throw new CostCeilingError(state.cost);
      }

      const translatedBlocks: { index: number; html: string }[] = [];
      let cost = state.cost;
      for (const block of chunk.blocks) {
        const { html, usage } = await translateInnerHtml(provider, block.innerHtml, glossary);
        translatedBlocks.push({ index: block.index, html });
        if (usage) cost = addUsage(cost, usage);
      }

      const result: ChunkResult = { key: chunk.key, blocks: translatedBlocks };
      saveChunkResult(jobDir, result);
      results.set(chunk.key, result);

      state = {
        ...state,
        chunks: { ...state.chunks, done: state.chunks.done + 1 },
        cost,
      };
      writeManifest(jobDir, state);
      onProgress?.(state);
    }

    // Re-stitch: apply translated inner HTML back into each spine item's blocks.
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

    state = { ...state, status: "done" };
    writeManifest(jobDir, state);
    onProgress?.(state);
    return state;
  } catch (err) {
    state = {
      ...state,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    writeManifest(jobDir, state);
    onProgress?.(state);
    throw err;
  }
}
