import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runJob, readManifest } from "../lib/core/job.ts";
import { FakeTranslator } from "../lib/core/providers/fake.ts";
import type {
  FillGlossaryInput,
  Translator,
  TranslateChunkInput,
} from "../lib/core/translator.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

/** Fake provider plus a glossary pass that renders every term the Hungarian way. */
class FillingTranslator implements Translator {
  readonly name = "filling";
  fills = 0;
  seenGlossaries: Record<string, string>[] = [];
  failFill = false;
  /** Terms the pass judges not to be names and leaves out of its answer. */
  omit: string[] = [];
  private inner = new FakeTranslator();

  async translateChunk(input: TranslateChunkInput) {
    this.seenGlossaries.push(input.glossary);
    return this.inner.translateChunk(input);
  }

  async fillGlossary(input: FillGlossaryInput) {
    this.fills += 1;
    if (this.failFill) throw new Error("provider unavailable");
    const kept = input.terms.filter((t) => !this.omit.includes(t));
    return {
      glossary: Object.fromEntries(kept.map((t) => [t, `${t} úr`])),
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  }
}

function freshJobDir(): string {
  return mkdtempSync(join(tmpdir(), "nativread-glossary-"));
}

test("decides name renderings once and hands them to every chunk", async () => {
  const jobDir = freshJobDir();
  const provider = new FillingTranslator();

  await runJob({ id: "g1", epubBytes: buildFixtureEpub(), provider, jobDir });

  expect(provider.fills).toBe(1);
  // The decided rendering reaches the chunks instead of the empty seeded value.
  expect(provider.seenGlossaries.length).toBeGreaterThan(0);
  for (const glossary of provider.seenGlossaries) {
    expect(glossary["Mr. Holloway"]).toBe("Mr. Holloway úr");
  }
  // ...and it is persisted, so a resume cannot re-decide them differently.
  expect(readManifest(jobDir)?.glossary?.["Mr. Holloway"]).toBe("Mr. Holloway úr");
});

test("a term the pass rejects is dropped, not pinned to its English form", async () => {
  const jobDir = freshJobDir();
  const provider = new FillingTranslator();
  // "Chapter One" is a heading, not a name: the pass omits it from its answer.
  provider.omit = ["Chapter One"];

  await runJob({ id: "g4", epubBytes: buildFixtureEpub(), provider, jobDir });

  const glossary = provider.seenGlossaries[0]!;
  expect(Object.keys(glossary)).toContain("Mr. Holloway");
  expect(Object.keys(glossary)).not.toContain("Chapter One");
});

test("a resumed job reuses the stored renderings instead of paying again", async () => {
  const jobDir = freshJobDir();
  const provider = new FillingTranslator();

  await runJob({ id: "g2", epubBytes: buildFixtureEpub(), provider, jobDir });
  await runJob({ id: "g2", epubBytes: buildFixtureEpub(), provider, jobDir });

  expect(provider.fills).toBe(1);
});

test("a failed glossary pass degrades to the seeded terms, it does not fail the book", async () => {
  const jobDir = freshJobDir();
  const provider = new FillingTranslator();
  provider.failFill = true;

  const state = await runJob({ id: "g3", epubBytes: buildFixtureEpub(), provider, jobDir });

  expect(state.status).toBe("done");
  // toHaveProperty would read the dot as a path separator, hence the key check.
  expect(Object.keys(provider.seenGlossaries[0]!)).toContain("Mr. Holloway");
});
