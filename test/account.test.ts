// T9 / GDPR: account export returns everything about the requesting user;
// deletion erases it — and never touches another user's data.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET as accountGet, DELETE as accountDelete } from "../app/api/account/route.ts";
import { POST as waitlistPost } from "../app/api/waitlist/route.ts";
import { grantTranslationEntitlement } from "../lib/server/entitlements.ts";
import { loadConfig } from "../lib/server/config.ts";
import { saveToLibrary } from "../lib/core/library.ts";

let root: string;
let jobsDir: string;
let libraryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nativread-account-"));
  jobsDir = join(root, "jobs");
  libraryDir = join(root, "library");
  mkdirSync(jobsDir, { recursive: true });
  process.env.JOBS_DIR = jobsDir;
  process.env.LIBRARY_DIR = libraryDir;
  process.env.ENTITLEMENTS_DIR = join(root, "entitlements");
  delete process.env.APPLE_CLIENT_IDS;
  delete process.env.GOOGLE_CLIENT_IDS;
  delete process.env.NATIVREAD_BACKEND_SHARED_SECRET;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function asUser(userId: string, method: string): Request {
  return new Request("http://test/api/account", {
    method,
    headers: { "x-nativread-user-id": userId },
  });
}

function seedUser(userId: string, suffix: string): void {
  const jobId = `00000000-0000-0000-0000-00000000000${suffix}`;
  const dir = join(jobsDir, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.epub"), "bytes");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: jobId,
      status: "done",
      provider: "fake",
      userId,
      words: 10,
      spineItemCount: 1,
      chunks: { total: 1, done: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  saveToLibrary({
    libraryDir,
    id: jobId,
    title: `Book ${suffix}`,
    sourceHash: suffix.repeat(64).slice(0, 64),
    userId,
    words: 10,
    costUsd: 0.1,
    epubBytes: new TextEncoder().encode("epub"),
  });
  grantTranslationEntitlement(loadConfig(), {
    userId,
    sourceHash: suffix.repeat(64).slice(0, 64),
    targetLanguage: "hu",
    transactionId: `txn-${suffix}`,
    productId: "nativread.translate.under100",
  });
}

test("export returns the caller's data and nothing of anyone else's", async () => {
  seedUser("user-a", "1");
  seedUser("user-b", "2");
  await waitlistPost(
    new Request("http://test/api/waitlist", {
      method: "POST",
      headers: { "x-nativread-user-id": "user-a", "content-type": "application/json" },
      body: JSON.stringify({ language: "de" }),
    }),
  );

  const data = await (await accountGet(asUser("user-a", "GET"))).json();

  expect(data.jobs).toHaveLength(1);
  expect(data.library).toHaveLength(1);
  expect(data.entitlements).toHaveLength(1);
  expect(data.entitlements[0].targetLanguage).toBe("hu");
  expect(data.waitlist).toEqual(["de"]);
  expect(JSON.stringify(data)).not.toContain("Book 2");
});

test("deletion erases the caller's data everywhere and leaves other users intact", async () => {
  seedUser("user-a", "1");
  seedUser("user-b", "2");
  await waitlistPost(
    new Request("http://test/api/waitlist", {
      method: "POST",
      headers: { "x-nativread-user-id": "user-a", "content-type": "application/json" },
      body: JSON.stringify({ language: "de" }),
    }),
  );

  const res = await (await accountDelete(asUser("user-a", "DELETE"))).json();
  expect(res.ok).toBe(true);

  // user-a: everything gone.
  const after = await (await accountGet(asUser("user-a", "GET"))).json();
  expect(after.jobs).toHaveLength(0);
  expect(after.library).toHaveLength(0);
  expect(after.entitlements).toHaveLength(0);
  expect(after.waitlist).toHaveLength(0);
  // Their event lines are gone too (hashed ids are still personal data).
  const events = readFileSync(join(jobsDir, "events.jsonl"), "utf8");
  expect(events.trim()).toBe("");

  // user-b: untouched.
  const other = await (await accountGet(asUser("user-b", "GET"))).json();
  expect(other.jobs).toHaveLength(1);
  expect(other.library).toHaveLength(1);
  expect(other.entitlements).toHaveLength(1);
  expect(existsSync(join(libraryDir, "00000000-0000-0000-0000-000000000002"))).toBe(true);
});
