import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveToLibrary, listLibrary, findBySourceHash, getLibraryEntry, hashSource } from "../lib/core/library.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "nativread-lib-"));
}

test("saves a book and lists it back", () => {
  const dir = freshDir();
  const bytes = buildFixtureEpub();
  const hash = hashSource(bytes);

  saveToLibrary({
    libraryDir: dir,
    id: "abc",
    title: "Test Book",
    sourceHash: hash,
    words: 1234,
    costUsd: 0.5,
    epubBytes: bytes,
  });

  const list = listLibrary(dir);
  expect(list).toHaveLength(1);
  expect(list[0]!.title).toBe("Test Book");
  expect(list[0]!.words).toBe(1234);

  rmSync(dir, { recursive: true, force: true });
});

test("dedup: an identical source is found by hash (so it is not re-translated)", () => {
  const dir = freshDir();
  const bytes = buildFixtureEpub();
  const hash = hashSource(bytes);
  saveToLibrary({ libraryDir: dir, id: "abc", title: "T", sourceHash: hash, words: 1, costUsd: 0, epubBytes: bytes });

  expect(findBySourceHash(dir, hash)?.id).toBe("abc");
  expect(findBySourceHash(dir, "nonexistent")).toBeUndefined();

  rmSync(dir, { recursive: true, force: true });
});

test("dedup is scoped by user", () => {
  const dir = freshDir();
  const bytes = buildFixtureEpub();
  const hash = hashSource(bytes);
  saveToLibrary({
    libraryDir: dir,
    id: "abc",
    title: "T",
    sourceHash: hash,
    userId: "user-a",
    words: 1,
    costUsd: 0,
    epubBytes: bytes,
  });

  expect(findBySourceHash(dir, hash, "user-a")?.id).toBe("abc");
  expect(findBySourceHash(dir, hash, "user-b")).toBeUndefined();

  rmSync(dir, { recursive: true, force: true });
});

test("a sample is listed in the library but excluded from dedup", () => {
  const dir = freshDir();
  const bytes = buildFixtureEpub();
  const hash = hashSource(bytes);
  saveToLibrary({ libraryDir: dir, id: "smp", title: "Sample", sourceHash: hash, words: 1, costUsd: 0, epubBytes: bytes, sample: true });

  // Visible in the library (so the user can find/read it)...
  expect(listLibrary(dir)).toHaveLength(1);
  expect(getLibraryEntry(dir, "smp")?.sample).toBe(true);
  // ...but it must NOT count as "already translated" — a full upload should still proceed.
  expect(findBySourceHash(dir, hash)).toBeUndefined();

  rmSync(dir, { recursive: true, force: true });
});

test("listLibrary is empty for a missing dir", () => {
  expect(listLibrary(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
});
