import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../lib/core/job.ts";
import { parseEpub } from "../lib/core/epub.ts";
import { FakeTranslator } from "../lib/core/providers/fake.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

test("sample mode translates only the leading fraction, leaving the rest original", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-sample-"));
  const epubBytes = buildFixtureEpub(); // 2 chapters, 1 chunk each

  const state = await runJob({
    id: "s1",
    epubBytes,
    provider: new FakeTranslator(),
    jobDir: dir,
    sampleFraction: 0.05, // first 5% -> just the opening chunk
  });

  expect(state.status).toBe("done");
  // Only the leading chunk is in scope, so total reflects the sample, not the whole book.
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

test("no sampleFraction translates the whole book", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-full-"));
  const state = await runJob({ id: "s2", epubBytes: buildFixtureEpub(), provider: new FakeTranslator(), jobDir: dir });
  expect(state.chunks.total).toBe(2);

  const out = parseEpub(new Uint8Array(readFileSync(join(dir, "output.epub"))));
  // Both chapters translated.
  expect(out.spine[1]!.content).not.toContain("Sarah Holloway had written to Mr. Holloway about the house.");

  rmSync(dir, { recursive: true, force: true });
});
