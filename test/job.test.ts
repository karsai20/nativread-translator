import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runJob, readManifest } from "../lib/core/job.ts";
import { parseEpub } from "../lib/core/epub.ts";
import { FakeTranslator, FAKE_PREFIX } from "../lib/core/providers/fake.ts";
import type { Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

// Wraps the fake provider and counts how many times the provider is actually called,
// so the resume test can prove finished chunks are not re-translated.
class SpyTranslator implements Translator {
  readonly name = "fake";
  calls = 0;
  private inner = new FakeTranslator();
  async translateChunk(input: TranslateChunkInput) {
    this.calls += 1;
    return this.inner.translateChunk(input);
  }
}

// Aborts the given controller right after the FIRST chunk is translated, so the next
// loop iteration sees the cancellation — proving the job stops resumably mid-book.
class AbortAfterFirst implements Translator {
  readonly name = "fake";
  calls = 0;
  private inner = new FakeTranslator();
  constructor(private readonly controller: AbortController) {}
  async translateChunk(input: TranslateChunkInput) {
    this.calls += 1;
    const out = await this.inner.translateChunk(input);
    if (this.calls === 1) this.controller.abort();
    return out;
  }
}

function freshJobDir(): string {
  return mkdtempSync(join(tmpdir(), "quire-job-"));
}

test("full job translates the book and writes a valid EPUB", async () => {
  const jobDir = freshJobDir();
  const spy = new SpyTranslator();

  const state = await runJob({
    id: "t1",
    epubBytes: buildFixtureEpub(),
    provider: spy,
    jobDir,
  });

  expect(state.status).toBe("done");
  expect(state.chunks.total).toBe(2); // one chunk per spine item
  expect(state.chunks.done).toBe(2);
  expect(spy.calls).toBe(2); // whole chunk translated in ONE call (context-aware)
  expect(state.words).toBeGreaterThan(0);

  // Output EPUB is valid and contains translated, markup-preserving content.
  const out = readFileSync(join(jobDir, "output.epub"));
  const reparsed = parseEpub(new Uint8Array(out));
  expect(reparsed.spine[0]!.content).toContain(FAKE_PREFIX.trim());
  expect(reparsed.spine[0]!.content).toContain("<em>"); // inline markup survived
  expect(reparsed.spine[0]!.content).toContain('href="ch2.xhtml"'); // link attrs survived

  rmSync(jobDir, { recursive: true, force: true });
});

test("resume: with all chunks on disk, re-run translates nothing", async () => {
  const jobDir = freshJobDir();

  await runJob({ id: "t2", epubBytes: buildFixtureEpub(), provider: new FakeTranslator(), jobDir });

  // Simulate a restart: output gone, chunk cache intact.
  rmSync(join(jobDir, "output.epub"), { force: true });

  const spy = new SpyTranslator();
  const state = await runJob({ id: "t2", epubBytes: buildFixtureEpub(), provider: spy, jobDir });

  expect(spy.calls).toBe(0); // nothing re-translated, nothing re-paid for
  expect(state.status).toBe("done");
  expect(existsSync(join(jobDir, "output.epub"))).toBe(true);

  rmSync(jobDir, { recursive: true, force: true });
});

test("resume: only missing chunks are re-translated", async () => {
  const jobDir = freshJobDir();

  await runJob({ id: "t3", epubBytes: buildFixtureEpub(), provider: new FakeTranslator(), jobDir });

  // Drop chapter two's chunk + the output, keep chapter one's chunk.
  rmSync(join(jobDir, "output.epub"), { force: true });
  rmSync(join(jobDir, "chunks", `${encodeURIComponent("OEBPS/ch2.xhtml#0")}.json`), {
    force: true,
  });

  const spy = new SpyTranslator();
  const state = await runJob({ id: "t3", epubBytes: buildFixtureEpub(), provider: spy, jobDir });

  expect(spy.calls).toBe(1); // only chapter two's chunk
  expect(state.status).toBe("done");

  rmSync(jobDir, { recursive: true, force: true });
});

test("stop: an aborted job stops resumably, keeping finished chunks", async () => {
  const jobDir = freshJobDir();
  const ac = new AbortController();
  const provider = new AbortAfterFirst(ac);

  const state = await runJob({
    id: "tc",
    epubBytes: buildFixtureEpub(),
    provider,
    jobDir,
    signal: ac.signal,
  });

  expect(state.status).toBe("stopped"); // resumable, not "error"
  expect(state.error).toBeUndefined();
  expect(provider.calls).toBe(1); // stopped before the second chunk
  expect(state.chunks.done).toBe(1);

  // The first chunk is persisted, so a later resume continues instead of re-paying.
  const ch1 = join(jobDir, "chunks", `${encodeURIComponent("OEBPS/ch1.xhtml#0")}.json`);
  expect(existsSync(ch1)).toBe(true);
  expect(existsSync(join(jobDir, "output.epub"))).toBe(false);

  // Resume to completion with a normal provider; the kept chunk is not re-translated.
  const spy = new SpyTranslator();
  const resumed = await runJob({ id: "tc", epubBytes: buildFixtureEpub(), provider: spy, jobDir });
  expect(resumed.status).toBe("done");
  expect(spy.calls).toBe(1); // only the remaining chunk

  rmSync(jobDir, { recursive: true, force: true });
});

test("manifest is persisted and reflects progress", async () => {
  const jobDir = freshJobDir();
  await runJob({ id: "t4", epubBytes: buildFixtureEpub(), provider: new FakeTranslator(), jobDir });

  const manifest = readManifest(jobDir);
  expect(manifest?.status).toBe("done");
  expect(manifest?.chunks.done).toBe(manifest?.chunks.total);
  expect(manifest?.cost.usd).toBeGreaterThanOrEqual(0);

  rmSync(jobDir, { recursive: true, force: true });
});
