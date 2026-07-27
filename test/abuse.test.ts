// E10 — automated abuse suite (blueprint §8 "Backend security hardening").
//
// The §8 manual security pass, automated: five adversarial probes that each
// ATTACK an implemented defense and assert it holds. A probe that stops
// FAILING means the server started ACCEPTING the abuse — i.e. a defense
// regressed — so every assertion carries a loud message naming the vector.
// Runs on every PR via `bun test` (CI runs the whole test dir).
//
// Probe → blueprint §8 line:
//   1. Auth on the free path      → §8 "Login required even for free tier."
//   2. Cross-user job-id guessing → §8 "hit another user's job id (isolation rejects)."
//   3. Purchase-txn replay        → §8 "replay a purchase txn (dedupe rejects)" (T7).
//   4. Hostile EPUB path-traversal→ §8 "EPUB = hostile zip … path-traversal rejection" (T5).
//   5. Moderation-trip fixture    → §8 "submit a moderation-trip fixture (refusal branch fires)" (E3).
//
// The per-user/day rate limit + global spend kill-switch (T4) remain separate
// P1 tasks. EPUB request/archive caps are attacked directly in probe 4b.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

import { POST as uploadPost } from "../app/api/upload/route.ts";
import { POST as translatePost } from "../app/api/translate/route.ts";
import { GET as statusGet } from "../app/api/status/route.ts";
import { GET as resultGet } from "../app/api/result/route.ts";
import { POST as entitlementPost } from "../app/api/entitlements/translation/route.ts";
import { runJob } from "../lib/core/job.ts";
import { parseEpub } from "../lib/core/epub.ts";
import { hasTranslationEntitlement } from "../lib/server/entitlements.ts";
import { loadConfig } from "../lib/server/config.ts";
import type { Translator } from "../lib/core/translator.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

// Env vars this suite drives; reset between tests so probes never leak mode.
const OVERRIDES = [
  "JOBS_DIR",
  "LIBRARY_DIR",
  "ENTITLEMENTS_DIR",
  "APPLE_CLIENT_IDS",
  "GOOGLE_CLIENT_IDS",
  "NATIVREAD_BACKEND_SHARED_SECRET",
  "STOREKIT_ALLOW_UNSIGNED_GRANTS",
  "REQUIRE_TRANSLATION_ENTITLEMENTS",
  "MAX_EPUB_UPLOAD_BYTES",
  "MAX_EPUB_ENTRIES",
  "MAX_EPUB_UNCOMPRESSED_BYTES",
] as const;

let root: string;
let jobsDir: string;
let libraryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nativread-abuse-"));
  jobsDir = join(root, "jobs");
  libraryDir = join(root, "library");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(libraryDir, { recursive: true });
  for (const key of OVERRIDES) delete process.env[key];
  process.env.JOBS_DIR = jobsDir;
  process.env.LIBRARY_DIR = libraryDir;
  process.env.ENTITLEMENTS_DIR = join(root, "entitlements");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of OVERRIDES) delete process.env[key];
});

/** A dev-mode request carrying an untrusted user id (dev/LAN header path). */
function asUser(url: string, userId: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), "x-nativread-user-id": userId },
  });
}

/** Persist a job dir owned by `userId`, like the upload route would. */
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
      sourceHash: "a".repeat(64),
      words: 0,
      spineItemCount: 1,
      chunks: { total: 1, done: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

// ── Probe 1 ── §8 "Login required even for free tier." ───────────────────────
// With Apple/Google login configured (public mode), the free-translation entry
// points must reject a request that carries no verified id-token. If a probe
// here 200s, an anonymous caller reached the paid attack surface for free.
test("probe 1: unauthenticated request to the free path is rejected (login required)", async () => {
  process.env.APPLE_CLIENT_IDS = "com.test.nativread"; // public mode: token required

  const body = new FormData();
  body.set("epub", new File([buildFixtureEpub()], "book.epub"));
  const upload = await uploadPost(new Request("https://x/api/upload", { method: "POST", body }));
  expect(upload.status, "ABUSE ACCEPTED: anonymous UPLOAD reached the free-translation path (§8 login required)").toBe(401);

  const translate = await translatePost(
    new Request("https://x/api/translate", {
      method: "POST",
      body: JSON.stringify({ id: "whatever" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(translate.status, "ABUSE ACCEPTED: anonymous TRANSLATE reached the free-translation path (§8 login required)").toBe(401);
});

// ── Probe 2 ── §8 "hit another user's job id (isolation rejects)." ────────────
// The isolation bright line, adversarially: user B guesses user A's job id and
// tries to run / read / peek at it. Every path must 404 identically (no
// existence leak), and A's own read must still work (proves it's not blanket-404).
test("probe 2: user B cannot run, read, or peek another user's job by guessing its id", async () => {
  writeJob("job-a", "user-a");

  const run = await translatePost(
    asUser("https://x/api/translate", "user-b", {
      method: "POST",
      body: JSON.stringify({ id: "job-a" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(run.status, "ABUSE ACCEPTED: user B started a translation on user A's job (§8 isolation)").toBe(404);

  const status = await statusGet(asUser("https://x/api/status?id=job-a", "user-b"));
  expect(status.status, "ABUSE ACCEPTED: user B read user A's job status (§8 isolation)").toBe(404);

  const result = await resultGet(asUser("https://x/api/result?id=job-a", "user-b"));
  expect(result.status, "ABUSE ACCEPTED: user B read user A's translated result (§8 isolation)").toBe(404);

  // Control: the real owner is NOT blanket-404'd — the 404s above are ownership, not breakage.
  const owner = await statusGet(asUser("https://x/api/status?id=job-a", "user-a"));
  expect(owner.status, "isolation over-rejected: the owner cannot read their own job").toBe(200);
});

// ── Probe 3 ── §8 "replay a purchase txn (dedupe rejects)" (T7). ──────────────
// A replayed StoreKit transaction id must never mint a second entitlement, and
// must never be re-bindable to a DIFFERENT user (txn theft). Dedup is keyed on
// the transaction id, so the second grant returns the first, unchanged.
test("probe 3: replaying a purchase transaction cannot mint or hijack an entitlement", async () => {
  process.env.STOREKIT_ALLOW_UNSIGNED_GRANTS = "1"; // enable grants (test-mode; prod verifies signatures)
  const sourceHash = "b".repeat(64);
  const grant = (userId: string) =>
    entitlementPost(
      asUser("https://x/api/entitlements/translation", userId, {
        method: "POST",
        body: JSON.stringify({ sourceHash, targetLanguage: "hu", transactionId: "txn-1", productId: "book" }),
        headers: { "content-type": "application/json" },
      }),
    );

  const first = (await (await grant("user-a")).json()) as { entitlement: { userId: string; createdAt: string } };
  const replay = (await (await grant("user-a")).json()) as { entitlement: { userId: string; createdAt: string } };
  expect(replay.entitlement.createdAt, "ABUSE ACCEPTED: replayed txn minted a fresh entitlement (§8 dedupe)").toBe(first.entitlement.createdAt);

  // Txn theft: user B replays user A's transaction id → gets A's row back, NOT a grant of their own.
  const stolen = (await (await grant("user-b")).json()) as { entitlement: { userId: string } };
  expect(stolen.entitlement.userId, "ABUSE ACCEPTED: replayed txn was rebound to a different user (§8 dedupe)").toBe("user-a");
  expect(
    hasTranslationEntitlement(loadConfig(), "user-b", sourceHash, "hu"),
    "ABUSE ACCEPTED: user B holds an entitlement from replaying user A's txn (§8 dedupe)",
  ).toBe(false);

  // And without server-side StoreKit verification enabled, grants are refused outright.
  delete process.env.STOREKIT_ALLOW_UNSIGNED_GRANTS;
  const refused = await grant("user-a");
  expect(refused.status, "ABUSE ACCEPTED: entitlement granted without server-side StoreKit verification (§8)").toBe(501);
});

// ── Probe 4 ── §8 "EPUB = hostile zip … path-traversal rejection" (T5). ───────
// A zip-slip EPUB references content via a traversal href (../../evil) and ships
// a matching entry named to escape the archive. The parser must neutralize the
// traversal (never surface a spine href that escapes the root) and never load
// the escaping entry — the delivery pipeline copies entries verbatim/re-zips in
// memory, so a leaked escaping path is the whole exploit.
test("probe 4: a zip-slip EPUB cannot escape the archive root", async () => {
  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Evil</dc:title></metadata>\n' +
    '  <manifest><item id="evil" href="../../../../etc/evil.xhtml" media-type="application/xhtml+xml"/></manifest>\n' +
    '  <spine><itemref idref="evil"/></spine>\n' +
    "</package>\n";
  const container =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
    "</container>\n";
  const malicious = zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    // The escaping payload, named to break out of any naive extractor.
    "../../../../etc/evil.xhtml": strToU8("<html><body><h1>pwned</h1></body></html>"),
  } as Record<string, Uint8Array>);

  // The traversal entry must never resolve to a loadable spine item: it collapses
  // to a path that doesn't exist in-archive, so parsing rejects the book outright.
  expect(() => parseEpub(malicious), "ABUSE ACCEPTED: zip-slip EPUB parsed with an escaping entry (§8 path-traversal)").toThrow();

  // And no legitimately-parsed EPUB ever yields a spine href that escapes the root.
  for (const item of parseEpub(buildFixtureEpub()).spine) {
    expect(item.href.startsWith("/") || item.href.includes(".."), `ABUSE ACCEPTED: spine href escapes archive root: ${item.href} (§8 path-traversal)`).toBe(false);
  }
});

// ── Probe 4b ── §8 "EPUB = hostile zip … hard size/entry caps." ─────────────
// The central directory must be checked before decompression, and the request
// stream itself must stop before an oversized multipart body is fully buffered.
test("probe 4b: oversized and decompression-bomb EPUBs are rejected before unzip", async () => {
  const fixture = buildFixtureEpub();
  expect(
    () => parseEpub(fixture, {
      maxArchiveBytes: fixture.byteLength + 1,
      maxEntries: 1,
      maxUncompressedBytes: 1024 * 1024,
    }),
    "ABUSE ACCEPTED: an EPUB exceeded the central-directory entry cap",
  ).toThrow(/entries/);

  const compressedBomb = zipSync({
    "payload.txt": strToU8("A".repeat(20_000)),
  });
  expect(
    () => parseEpub(compressedBomb, {
      maxArchiveBytes: compressedBomb.byteLength + 1,
      maxEntries: 10,
      maxUncompressedBytes: 1_024,
    }),
    "ABUSE ACCEPTED: a highly-compressed payload exceeded the expanded-size cap",
  ).toThrow(/expands beyond/);

  process.env.MAX_EPUB_UPLOAD_BYTES = "1024";
  const body = new FormData();
  body.set("epub", new File([new Uint8Array(70 * 1024)], "oversized.epub"));
  const response = await uploadPost(asUser("https://x/api/upload", "user-a", {
    method: "POST",
    body,
  }));
  expect(
    response.status,
    "ABUSE ACCEPTED: oversized multipart upload crossed the bounded request stream",
  ).toBe(413);
});

// ── Probe 5 ── §8 "submit a moderation-trip fixture (refusal branch fires)" (E3).
// A provider that refuses on content grounds must end the job in the distinct
// non-retry class, tell the user the free credit was NOT consumed, and cache
// nothing — never a silent generic failure that re-burns cost on retry.
test("probe 5: a moderation-refusing provider trips the non-retry refusal branch", async () => {
  const dir = mkdtempSync(join(root, "refusal-"));
  const refusing: Translator = {
    name: "refusing",
    async translateChunk() {
      return { text: "Sorry, I can't translate this content." };
    },
  };

  const state = await runJob({ id: "abuse-refusal", epubBytes: buildFixtureEpub(), provider: refusing, jobDir: dir });

  expect(state.status, "moderation refusal did not end the job in error").toBe("error");
  expect(state.errorCode, "ABUSE ACCEPTED: moderation refusal masqueraded as a retryable failure (§8 refusal branch)").toBe("moderation_refusal");
  expect(state.error, "refusal copy must state the free credit is not consumed").toContain("ingyenes");
  expect(readdirSync(join(dir, "chunks")), "ABUSE ACCEPTED: a refused chunk was cached (half-translated book persisted)").toHaveLength(0);
});
