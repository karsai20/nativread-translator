import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob, takeFirstContentChapter } from "../lib/core/job.ts";
import type { Chunk } from "../lib/core/chunker.ts";
import { parseEpub } from "../lib/core/epub.ts";
import { FakeTranslator } from "../lib/core/providers/fake.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

test("sample mode translates only the first content chapter, leaving the rest original", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nativread-sample-"));
  const epubBytes = buildFixtureEpub(); // 2 chapters, 1 chunk each

  const state = await runJob({
    id: "s1",
    epubBytes,
    provider: new FakeTranslator(),
    jobDir: dir,
    sample: true,
  });

  expect(state.status).toBe("done");
  // Only the selected chapter is in scope, so total reflects the preview.
  expect(state.chunks.total).toBe(1);
  expect(state.chunks.done).toBe(1);

  const out = parseEpub(new Uint8Array(readFileSync(join(dir, "output.epub"))));
  const ch1 = out.spine[0]!.content;
  const ch2 = out.spine[1]!.content;

  // Chapter 1 (in the sample) is translated by the fake (uppercased words).
  expect(ch1).toContain("HOLLOWAY");
  // Chapter 2 (outside the sample) is left exactly as the English original.
  expect(ch2).toContain("Sarah Holloway had written to Mr. Holloway about the house.");

  rmSync(dir, { recursive: true, force: true });
});

test("content preview skips short front matter", () => {
  const chunk = (href: string, key: string, text: string): Chunk => ({
    itemHref: href,
    key,
    blocks: [{ index: 0, innerHtml: text }],
  });
  const front = chunk("front.xhtml", "front#0", "Title Copyright Contents");
  const chapter = chunk(
    "chapter-1.xhtml",
    "chapter-1#0",
    Array.from({ length: 300 }, (_, index) => `word${index}`).join(" "),
  );
  const later = chunk(
    "chapter-2.xhtml",
    "chapter-2#0",
    Array.from({ length: 300 }, (_, index) => `later${index}`).join(" "),
  );

  expect(takeFirstContentChapter([front, chapter, later])).toEqual([chapter]);
});

test("sample disabled translates the whole book", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nativread-full-"));
  const state = await runJob({ id: "s2", epubBytes: buildFixtureEpub(), provider: new FakeTranslator(), jobDir: dir });
  expect(state.chunks.total).toBe(2);

  const out = parseEpub(new Uint8Array(readFileSync(join(dir, "output.epub"))));
  // Both chapters translated.
  expect(out.spine[1]!.content).not.toContain("Sarah Holloway had written to Mr. Holloway about the house.");

  rmSync(dir, { recursive: true, force: true });
});
