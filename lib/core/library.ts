// Persistent household library of translated books.
//
// On the private Proxmox homelab it is fine (and wanted) to keep translated books so the
// household never re-translates the same book. Each entry is a folder under the library
// dir holding the translated EPUB plus metadata, including a hash of the SOURCE epub so
// an identical upload is recognised and served instead of re-translated.

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface LibraryEntry {
  id: string;
  title: string;
  sourceHash: string;
  userId?: string;
  words: number;
  costUsd: number;
  createdAt: string; // ISO
  /** True for a 5% preview. Shown in the library but excluded from source-hash dedup. */
  sample?: boolean;
}

/** Stable content hash of a source EPUB, for dedup. */
export function hashSource(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function metaPath(libraryDir: string, id: string): string {
  return join(libraryDir, id, "meta.json");
}

export function libraryEpubPath(libraryDir: string, id: string): string {
  return join(libraryDir, id, "book.epub");
}

export function listLibrary(libraryDir: string, userId?: string): LibraryEntry[] {
  if (!existsSync(libraryDir)) return [];
  const entries: LibraryEntry[] = [];
  for (const id of readdirSync(libraryDir)) {
    const mp = metaPath(libraryDir, id);
    if (!existsSync(mp)) continue;
    try {
      const entry = JSON.parse(readFileSync(mp, "utf8")) as LibraryEntry;
      if (!userId || entry.userId === userId) entries.push(entry);
    } catch {
      // Skip a corrupt entry rather than failing the whole listing.
    }
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Look up a single entry by id (used to recover the sample flag for the reader). */
export function getLibraryEntry(libraryDir: string, id: string): LibraryEntry | undefined {
  const mp = metaPath(libraryDir, id);
  if (!existsSync(mp)) return undefined;
  try {
    return JSON.parse(readFileSync(mp, "utf8")) as LibraryEntry;
  } catch {
    return undefined;
  }
}

export function findBySourceHash(
  libraryDir: string,
  sourceHash: string,
  userId?: string,
): LibraryEntry | undefined {
  // Samples are partial previews, so they must never satisfy a full-book upload — only a
  // real (non-sample) translation counts as "already translated".
  return listLibrary(libraryDir, userId).find((e) => e.sourceHash === sourceHash && !e.sample);
}

export interface SaveToLibraryInput {
  libraryDir: string;
  id: string;
  title: string;
  sourceHash: string;
  userId?: string;
  words: number;
  costUsd: number;
  epubBytes: Uint8Array;
  sample?: boolean;
}

export function saveToLibrary(input: SaveToLibraryInput): LibraryEntry {
  const dir = join(input.libraryDir, input.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(libraryEpubPath(input.libraryDir, input.id), input.epubBytes);

  const entry: LibraryEntry = {
    id: input.id,
    title: input.title,
    sourceHash: input.sourceHash,
    ...(input.userId ? { userId: input.userId } : {}),
    words: input.words,
    costUsd: input.costUsd,
    createdAt: new Date().toISOString(),
    ...(input.sample ? { sample: true } : {}),
  };
  writeFileSync(metaPath(input.libraryDir, input.id), JSON.stringify(entry, null, 2));
  return entry;
}
