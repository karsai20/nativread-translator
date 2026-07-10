// E5 (eng D11): consumables have no Apple-side restore — the server
// entitlement row IS the restore. Upload reports entitledLanguages so a
// reinstalled client re-delivers/re-runs at no charge, per user, per language.
// E6: an invalid EPUB emits the import-failed funnel bucket.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POST as uploadPost } from "../app/api/upload/route.ts";
import { grantTranslationEntitlement } from "../lib/server/entitlements.ts";
import { loadConfig } from "../lib/server/config.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";
import { hashSource } from "../lib/core/library.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quire-upload-"));
  process.env.JOBS_DIR = join(root, "jobs");
  process.env.LIBRARY_DIR = join(root, "library");
  process.env.ENTITLEMENTS_DIR = join(root, "entitlements");
  delete process.env.APPLE_CLIENT_IDS;
  delete process.env.GOOGLE_CLIENT_IDS;
  delete process.env.NATIVREAD_BACKEND_SHARED_SECRET;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function uploadRequest(userId: string, bytes: Uint8Array): Request {
  const form = new FormData();
  form.set("epub", new File([bytes as BlobPart], "book.epub", { type: "application/epub+zip" }));
  return new Request("http://test/api/upload", {
    method: "POST",
    headers: { "x-nativread-user-id": userId },
    body: form,
  });
}

test("re-upload after purchase reports the entitled language — the restore path", async () => {
  const bytes = buildFixtureEpub();
  grantTranslationEntitlement(loadConfig(), {
    userId: "user-a",
    sourceHash: hashSource(bytes),
    targetLanguage: "hu",
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });

  const mine = await (await uploadPost(uploadRequest("user-a", bytes))).json();
  expect(mine.entitledLanguages).toEqual(["hu"]);

  // Another user's upload of the same book restores nothing (per-user isolation).
  const theirs = await (await uploadPost(uploadRequest("user-b", bytes))).json();
  expect(theirs.entitledLanguages).toEqual([]);
});

test("upload without purchase reports no entitlements", async () => {
  const res = await (await uploadPost(uploadRequest("user-a", buildFixtureEpub()))).json();
  expect(res.entitledLanguages).toEqual([]);
});

test("invalid EPUB emits the import-failed funnel bucket", async () => {
  const res = await uploadPost(uploadRequest("user-a", new TextEncoder().encode("not a zip")));
  expect(res.status).toBe(400);

  const lines = readFileSync(join(root, "jobs", "events.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).type).toBe("import-failed");
});
