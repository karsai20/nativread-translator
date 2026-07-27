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

function freshJobDir(): string {
  return mkdtempSync(join(tmpdir(), "nativread-job-"));
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

test("full job preserves the original hyperlink targets and inline structure", async () => {
  const jobDir = freshJobDir();
  await runJob({
    id: "structure",
    epubBytes: buildFixtureEpub([
      {
        href: "ch1.xhtml",
        id: "ch1",
        title: "Chapter One",
        body: '<p>He <em>found <a class="xref" href="ch2.xhtml">the letter</a></em>.</p>',
      },
      {
        href: "ch2.xhtml",
        id: "ch2",
        title: "Chapter Two",
        body: '<p id="target">The answer waited there.</p>',
      },
    ]),
    provider: new FakeTranslator(),
    jobDir,
  });

  const reparsed = parseEpub(new Uint8Array(readFileSync(join(jobDir, "output.epub"))));
  expect(reparsed.spine[0]!.content).toContain('<a class="xref" href="ch2.xhtml">');
  expect(reparsed.spine[0]!.content).toContain("</a></em>");
  expect(reparsed.spine[1]!.content).toContain('id="target"');
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

test("manifest is persisted and reflects progress", async () => {
  const jobDir = freshJobDir();
  await runJob({ id: "t4", epubBytes: buildFixtureEpub(), provider: new FakeTranslator(), jobDir });

  const manifest = readManifest(jobDir);
  expect(manifest?.status).toBe("done");
  expect(manifest?.chunks.done).toBe(manifest?.chunks.total);
  expect(manifest?.cost.usd).toBeGreaterThanOrEqual(0);

  rmSync(jobDir, { recursive: true, force: true });
});
