import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../lib/server/config.ts";
import { pruneExpiredArtifacts } from "../lib/server/retention.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nativread-retention-"));
  process.env.JOBS_DIR = join(root, "jobs");
  process.env.LIBRARY_DIR = join(root, "library");
  process.env.ARTIFACT_RETENTION_HOURS = "24";
  delete process.env.APPLE_CLIENT_IDS;
  delete process.env.GOOGLE_CLIENT_IDS;
});

afterEach(() => {
  delete process.env.ARTIFACT_RETENTION_HOURS;
  rmSync(root, { recursive: true, force: true });
});

function writeArtifact(id: string, createdAt: string): void {
  const job = join(root, "jobs", id);
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "source.epub"), "source");
  writeFileSync(
    join(job, "manifest.json"),
    JSON.stringify({ id, status: "done", provider: "fake", createdAt }),
  );

  const library = join(root, "library", id);
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "book.epub"), "result");
  writeFileSync(
    join(library, "meta.json"),
    JSON.stringify({
      id,
      title: id,
      sourceHash: id,
      words: 1,
      costUsd: 0,
      createdAt,
    }),
  );
}

test("retention removes expired source and translated copies but keeps fresh jobs", () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  writeArtifact("old-job", "2026-07-12T11:00:00Z");
  writeArtifact("fresh-job", "2026-07-14T11:00:00Z");

  const orphan = join(root, "library", "corrupt-orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "book.epub"), "result");
  writeFileSync(join(orphan, "meta.json"), "not-json");
  const old = new Date("2026-07-12T11:00:00Z");
  utimesSync(orphan, old, old);

  expect(pruneExpiredArtifacts(loadConfig(), now)).toBe(2);
  expect(existsSync(join(root, "jobs", "old-job"))).toBe(false);
  expect(existsSync(join(root, "library", "old-job"))).toBe(false);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(join(root, "jobs", "fresh-job"))).toBe(true);
  expect(existsSync(join(root, "library", "fresh-job"))).toBe(true);
});

test("retention is disabled by default in LAN/dev mode", () => {
  delete process.env.ARTIFACT_RETENTION_HOURS;
  writeArtifact("household-book", "2020-01-01T00:00:00Z");

  expect(pruneExpiredArtifacts(loadConfig(), Date.now())).toBe(0);
  expect(existsSync(join(root, "jobs", "household-book"))).toBe(true);
});

test("public retention cannot be disabled or configured beyond 30 days", () => {
  process.env.APPLE_CLIENT_IDS = "com.karsai.nativread";

  process.env.ARTIFACT_RETENTION_HOURS = "0";
  expect(loadConfig().artifactRetentionHours).toBe(24);

  process.env.ARTIFACT_RETENTION_HOURS = String(90 * 24);
  expect(loadConfig().artifactRetentionHours).toBe(30 * 24);
});
