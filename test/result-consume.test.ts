import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET as resultGet } from "../app/api/result/route.ts";

let root: string;
let jobsDir: string;
let libraryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nativread-result-consume-"));
  jobsDir = join(root, "jobs");
  libraryDir = join(root, "library");
  process.env.JOBS_DIR = jobsDir;
  process.env.LIBRARY_DIR = libraryDir;
  delete process.env.APPLE_CLIENT_IDS;
  delete process.env.GOOGLE_CLIENT_IDS;
  delete process.env.NATIVREAD_BACKEND_SHARED_SECRET;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFinishedResult(id: string, userId: string): void {
  const jobDir = join(jobsDir, id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "source.epub"), "uploaded source");
  writeFileSync(join(jobDir, "output.epub"), "translated result");
  writeFileSync(
    join(jobDir, "manifest.json"),
    JSON.stringify({ id, status: "done", provider: "fake", userId }),
  );

  const libraryEntryDir = join(libraryDir, id);
  mkdirSync(libraryEntryDir, { recursive: true });
  writeFileSync(join(libraryEntryDir, "book.epub"), "translated result");
  writeFileSync(
    join(libraryEntryDir, "meta.json"),
    JSON.stringify({
      id,
      title: "Test Book",
      sourceHash: "abc",
      userId,
      words: 2,
      costUsd: 0,
      createdAt: new Date().toISOString(),
    }),
  );
}

function request(id: string, userId: string): Request {
  return new Request(`https://x/api/result?id=${id}&download=1&consume=1`, {
    headers: { "x-nativread-user-id": userId },
  });
}

test("consumed download returns the EPUB and removes source, chunks, and result copies", async () => {
  writeFinishedResult("job-a", "user-a");

  const response = await resultGet(request("job-a", "user-a"));

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("translated result");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(existsSync(join(jobsDir, "job-a"))).toBe(false);
  expect(existsSync(join(libraryDir, "job-a"))).toBe(false);
});

test("a different user cannot consume or delete the result", async () => {
  writeFinishedResult("job-a", "user-a");

  const response = await resultGet(request("job-a", "user-b"));

  expect(response.status).toBe(404);
  expect(existsSync(join(jobsDir, "job-a"))).toBe(true);
  expect(existsSync(join(libraryDir, "job-a"))).toBe(true);
});
