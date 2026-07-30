import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET as jobsGet } from "../app/api/jobs/route.ts";
import { GET as libraryGet } from "../app/api/library/route.ts";
import { DELETE as jobDelete } from "../app/api/job/route.ts";
import { POST as jobCancel } from "../app/api/job/cancel/route.ts";
import { POST as jobPause } from "../app/api/job/pause/route.ts";
import { POST as jobResume } from "../app/api/job/resume/route.ts";

// These routes are exercised as real handlers in dev mode (no OIDC configured),
// where `x-nativread-user-id` supplies the userId. That lets us prove per-user
// isolation end-to-end without minting id-tokens: the ownership check that runs
// is the same one that runs in production once OIDC derives the userId.

let root: string;
let jobsDir: string;
let libraryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nativread-iso-"));
  jobsDir = join(root, "jobs");
  libraryDir = join(root, "library");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(libraryDir, { recursive: true });
  process.env.JOBS_DIR = jobsDir;
  process.env.LIBRARY_DIR = libraryDir;
  // Force dev mode: no OIDC providers, no shared secret → header supplies userId.
  delete process.env.APPLE_CLIENT_IDS;
  delete process.env.GOOGLE_CLIENT_IDS;
  delete process.env.NATIVREAD_BACKEND_SHARED_SECRET;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJob(id: string, userId: string): void {
  const dir = join(jobsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.epub"), "epub-bytes");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      status: "done",
      provider: "fake",
      userId,
      words: 0,
      spineItemCount: 1,
      chunks: { total: 1, done: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

function writeLibraryEntry(id: string, userId: string): void {
  const dir = join(libraryDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id,
      title: `Book ${id}`,
      sourceHash: id.repeat(8),
      userId,
      words: 0,
      costUsd: 0,
      createdAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, "book.epub"), "epub-bytes");
}

function asUser(url: string, userId: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), "x-nativread-user-id": userId },
  });
}

test("GET /api/jobs returns only the caller's own jobs", async () => {
  writeJob("job-a", "user-a");
  writeJob("job-b", "user-b");

  const res = await jobsGet(asUser("https://x/api/jobs", "user-b"));
  const { jobs } = (await res.json()) as { jobs: Array<{ id: string }> };

  expect(jobs.map((j) => j.id)).toEqual(["job-b"]);
});

test("GET /api/library returns only the caller's own books", async () => {
  writeLibraryEntry("lib-a", "user-a");
  writeLibraryEntry("lib-b", "user-b");

  const res = await libraryGet(asUser("https://x/api/library", "user-b"));
  const { books } = (await res.json()) as { books: Array<{ id: string }> };

  expect(books.map((b) => b.id)).toEqual(["lib-b"]);
});

test("DELETE /api/job cannot delete another user's job", async () => {
  writeJob("job-a", "user-a");

  const res = await jobDelete(
    asUser("https://x/api/job?id=job-a", "user-b", { method: "DELETE" }),
  );

  expect(res.status).toBe(404);
  expect(existsSync(join(jobsDir, "job-a"))).toBe(true); // still there
});

test("DELETE /api/job removes the caller's own job", async () => {
  writeJob("job-a", "user-a");

  const res = await jobDelete(
    asUser("https://x/api/job?id=job-a", "user-a", { method: "DELETE" }),
  );

  expect(res.status).toBe(200);
  expect(existsSync(join(jobsDir, "job-a"))).toBe(false);
});

test("job control actions 404 on another user's job", async () => {
  for (const handler of [jobCancel, jobPause, jobResume]) {
    writeJob("job-a", "user-a");
    const res = await handler(
      asUser("https://x/api/job/x", "user-b", {
        method: "POST",
        body: JSON.stringify({ id: "job-a" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(404);
  }
});

test("an unauthenticated request in dev mode still resolves to 'local' (no crash)", async () => {
  writeJob("job-local", "local");
  const res = await jobsGet(new Request("https://x/api/jobs"));
  const { jobs } = (await res.json()) as { jobs: Array<{ id: string }> };
  expect(jobs.map((j) => j.id)).toEqual(["job-local"]);
});

test("an ownerless job (no userId) is fail-closed: excluded from listing and 404 on mutation", async () => {
  const dir = join(jobsDir, "job-orphan");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.epub"), "epub-bytes");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ id: "job-orphan", status: "done", provider: "fake", createdAt: new Date().toISOString() }),
  );

  const list = await jobsGet(asUser("https://x/api/jobs", "user-b"));
  expect(((await list.json()) as { jobs: unknown[] }).jobs).toEqual([]);

  const del = await jobDelete(asUser("https://x/api/job?id=job-orphan", "user-b", { method: "DELETE" }));
  expect(del.status).toBe(404);
  expect(existsSync(dir)).toBe(true);
});

test("DELETE withLibrary=1 refuses when the library entry is owned by another user", async () => {
  // Contrived divergence: job owned by user-b, library entry for the same id by user-a.
  writeJob("job-x", "user-b");
  writeLibraryEntry("job-x", "user-a");

  const res = await jobDelete(
    asUser("https://x/api/job?id=job-x&withLibrary=1", "user-b", { method: "DELETE" }),
  );

  expect(res.status).toBe(404);
  expect(existsSync(join(libraryDir, "job-x"))).toBe(true); // library copy survives
});

test("DELETE withLibrary=1 refuses when the library dir exists but its owner is unverifiable", async () => {
  writeJob("job-y", "user-a");
  // A library dir with no readable meta.json → ownership cannot be confirmed.
  const libDir = join(libraryDir, "job-y");
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(libDir, "book.epub"), "epub-bytes");

  const res = await jobDelete(
    asUser("https://x/api/job?id=job-y&withLibrary=1", "user-a", { method: "DELETE" }),
  );

  expect(res.status).toBe(404);
  expect(existsSync(libDir)).toBe(true); // unverifiable dir is left intact
  expect(existsSync(join(jobsDir, "job-y"))).toBe(true); // whole op refused
});
