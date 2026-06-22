import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runJob } from "../lib/core/job.ts";
import { FakeTranslator, fakeRendering } from "../lib/core/providers/fake.ts";
import type {
  Translator,
  TranslateChunkInput,
  ResolveGlossaryInput,
} from "../lib/core/translator.ts";
import type { GlossaryMap } from "../lib/core/glossary.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

// Records the glossary handed to translateChunk and counts resolveGlossary calls.
class CapturingTranslator implements Translator {
  readonly name = "fake";
  resolveCalls = 0;
  glossariesSeen: GlossaryMap[] = [];
  private inner = new FakeTranslator();

  translateChunk(input: TranslateChunkInput) {
    this.glossariesSeen.push(input.glossary);
    return this.inner.translateChunk(input);
  }
  resolveGlossary(input: ResolveGlossaryInput) {
    this.resolveCalls += 1;
    return this.inner.resolveGlossary(input);
  }
}

function freshJobDir(): string {
  return mkdtempSync(join(tmpdir(), "quire-gloss-"));
}

test("recurring names get one fixed rendering, carried into every chunk and persisted", async () => {
  const jobDir = freshJobDir();
  const provider = new CapturingTranslator();

  await runJob({ id: "g1", epubBytes: buildFixtureEpub(), provider, jobDir });

  // Resolved once up front, not per chunk.
  expect(provider.resolveCalls).toBe(1);

  // The persisted glossary fixes a canonical rendering for the recurring name.
  const saved = JSON.parse(readFileSync(join(jobDir, "glossary.json"), "utf8")) as GlossaryMap;
  expect(saved["Mr. Holloway"]).toBe(fakeRendering("Mr. Holloway"));

  // EVERY translated chunk received the resolved (non-empty) target, so the name is
  // identical book-wide — not re-derived per chunk.
  expect(provider.glossariesSeen.length).toBeGreaterThan(0);
  for (const g of provider.glossariesSeen) {
    expect(g["Mr. Holloway"]).toBe(fakeRendering("Mr. Holloway"));
  }

  rmSync(jobDir, { recursive: true, force: true });
});

test("resume reuses the saved glossary and does not re-resolve", async () => {
  const jobDir = freshJobDir();
  await runJob({ id: "g2", epubBytes: buildFixtureEpub(), provider: new FakeTranslator(), jobDir });
  expect(existsSync(join(jobDir, "glossary.json"))).toBe(true);

  // Simulate a restart: output gone, chunk cache + glossary intact.
  rmSync(join(jobDir, "output.epub"), { force: true });

  const provider = new CapturingTranslator();
  await runJob({ id: "g2", epubBytes: buildFixtureEpub(), provider, jobDir });

  expect(provider.resolveCalls).toBe(0); // glossary.json reused, no re-resolve
  expect(provider.glossariesSeen.length).toBe(0); // chunks cached, nothing re-translated

  rmSync(jobDir, { recursive: true, force: true });
});
