import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../lib/core/job.ts";
import { FakeTranslator } from "../lib/core/providers/fake.ts";
import type { Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

test("one failing chunk does not abort the whole book; others are cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-fail-"));
  const fake = new FakeTranslator();
  let calls = 0;
  // Fail the very first translateChunk call, succeed afterwards.
  const flaky: Translator = {
    name: "flaky",
    async translateChunk(i: TranslateChunkInput) {
      calls++;
      if (calls === 1) throw new Error("boom");
      return fake.translateChunk(i);
    },
  };

  const state = await runJob({ id: "f1", epubBytes: buildFixtureEpub(), provider: flaky, jobDir: dir });
  // The book has 2 chunks; one failed, one (or more) succeeded and is cached.
  expect(state.status).toBe("error");
  expect(state.chunks.done).toBeGreaterThanOrEqual(1);
  expect(state.error).toContain("szakasz");

  rmSync(dir, { recursive: true, force: true });
});
