// E3 (eng D4): a provider refusal is deterministic — the job must end with a
// distinct non-retry error class, not the generic "try again" copy, and the
// refused chunk must stay uncached (nothing half-baked in the book).

import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../lib/core/job.ts";
import type { Translator } from "../lib/core/translator.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

// Refuses every request, like a moderation-filtered provider. No block
// markers in the output, so the pipeline walks its fallback paths and the
// guard sees the refusal text in every translated block.
const refusing: Translator = {
  name: "refusing",
  async translateChunk() {
    return { text: "Sorry, I can't translate this content." };
  },
};

test("a moderation refusal ends the job with the non-retry error class", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nativread-refusal-"));

  const state = await runJob({
    id: "r1",
    epubBytes: buildFixtureEpub(),
    provider: refusing,
    jobDir: dir,
  });

  expect(state.status).toBe("error");
  expect(state.errorCode).toBe("moderation_refusal");
  expect(state.refusedChunks).toBeGreaterThanOrEqual(1);
  // Non-retry copy, and it must say the free credit is not consumed.
  expect(state.error).toContain("tartalmi okból");
  expect(state.error).toContain("ingyenes");
  // Refused chunks are never cached — nothing half-translated persists.
  expect(readdirSync(join(dir, "chunks"))).toHaveLength(0);

  rmSync(dir, { recursive: true, force: true });
});

test("transient failures keep the retryable copy and no errorCode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nativread-transient-"));
  const flaky: Translator = {
    name: "flaky",
    async translateChunk() {
      throw new Error("ECONNRESET");
    },
  };

  const state = await runJob({
    id: "t1",
    epubBytes: buildFixtureEpub(),
    provider: flaky,
    jobDir: dir,
  });

  expect(state.status).toBe("error");
  expect(state.errorCode).toBeUndefined();
  expect(state.error).toContain("Indítsd újra");

  rmSync(dir, { recursive: true, force: true });
});
