import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runJob, readManifest } from "../lib/core/job.ts";
import { FakeTranslator } from "../lib/core/providers/fake.ts";
import type { Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

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
  return mkdtempSync(join(tmpdir(), "nativread-ctrl-"));
}

// shouldStop is polled at the TOP of the loop before each chunk. With 2 chunks,
// returning the signal on the 2nd poll stops after exactly one chunk is done.
function stopAfter(n: number, signal: "pause" | "cancel"): () => "pause" | "cancel" | undefined {
  let polls = 0;
  return () => (polls++ >= n ? signal : undefined);
}

test("pause stops the loop, keeps chunk cache, and marks paused", async () => {
  const jobDir = freshJobDir();

  const state = await runJob({
    id: "p1",
    epubBytes: buildFixtureEpub(),
    provider: new FakeTranslator(),
    jobDir,
    shouldStop: stopAfter(1, "pause"),
  });

  expect(state.status).toBe("paused");
  expect(state.chunks.done).toBe(1);
  expect(state.chunks.done).toBeLessThan(state.chunks.total);
  // The done chunk is persisted on disk so resume re-pays nothing.
  expect(existsSync(join(jobDir, "chunks", `${encodeURIComponent("OEBPS/ch1.xhtml#0")}.json`))).toBe(true);
  // A paused job is not finished.
  expect(state.finishedAt).toBeUndefined();

  rmSync(jobDir, { recursive: true, force: true });
});

test("resume after pause re-pays nothing and completes", async () => {
  const jobDir = freshJobDir();

  const paused = await runJob({
    id: "p2",
    epubBytes: buildFixtureEpub(),
    provider: new FakeTranslator(),
    jobDir,
    shouldStop: stopAfter(1, "pause"),
  });
  expect(paused.status).toBe("paused");
  const doneAtPause = paused.chunks.done;

  const spy = new SpyTranslator();
  const resumed = await runJob({
    id: "p2",
    epubBytes: buildFixtureEpub(),
    provider: spy,
    jobDir,
  });

  expect(spy.calls).toBe(resumed.chunks.total - doneAtPause);
  expect(resumed.status).toBe("done");
  expect(resumed.chunks.done).toBe(resumed.chunks.total);

  rmSync(jobDir, { recursive: true, force: true });
});

test("cancel sets cancelled status and does not throw", async () => {
  const jobDir = freshJobDir();

  const state = await runJob({
    id: "c1",
    epubBytes: buildFixtureEpub(),
    provider: new FakeTranslator(),
    jobDir,
    shouldStop: stopAfter(1, "cancel"),
  });

  expect(state.status).toBe("cancelled");
  expect(state.finishedAt).toBeDefined();
  expect(readManifest(jobDir)?.status).toBe("cancelled");

  rmSync(jobDir, { recursive: true, force: true });
});

test("timing and timestamp fields are populated on a completed job", async () => {
  const jobDir = freshJobDir();

  const state = await runJob({
    id: "ts1",
    epubBytes: buildFixtureEpub(),
    provider: new FakeTranslator(),
    jobDir,
  });

  expect(state.chunkDurationsMs?.length).toBeGreaterThan(0);
  for (const iso of [state.createdAt, state.startedAt, state.updatedAt, state.finishedAt]) {
    expect(iso).toBeDefined();
    expect(Number.isNaN(Date.parse(iso as string))).toBe(false);
  }
  expect(Date.parse(state.updatedAt as string)).toBeGreaterThanOrEqual(Date.parse(state.startedAt as string));

  rmSync(jobDir, { recursive: true, force: true });
});
