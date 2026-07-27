// E7: waitlist rows are per-(user, language), deduped, validated, isolated.
// E6: joining emits a metadata-only funnel event with a hashed user id.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POST as waitlistPost } from "../app/api/waitlist/route.ts";

let root: string;
let jobsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nativread-waitlist-"));
  jobsDir = join(root, "jobs");
  process.env.JOBS_DIR = jobsDir;
  process.env.LIBRARY_DIR = join(root, "library");
  process.env.ENTITLEMENTS_DIR = join(root, "entitlements");
  delete process.env.APPLE_CLIENT_IDS;
  delete process.env.GOOGLE_CLIENT_IDS;
  delete process.env.NATIVREAD_BACKEND_SHARED_SECRET;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function join_(userId: string, language: unknown): Request {
  return new Request("http://test/api/waitlist", {
    method: "POST",
    headers: { "x-nativread-user-id": userId, "content-type": "application/json" },
    body: JSON.stringify({ language }),
  });
}

test("dedupes per (user, language) and stays metadata-only", async () => {
  expect((await waitlistPost(join_("user-a", "de"))).status).toBe(200);
  const second = await (await waitlistPost(join_("user-a", "de"))).json();
  expect(second.deduped).toBe(true);

  await waitlistPost(join_("user-a", "es"));
  await waitlistPost(join_("user-b", "de"));

  const rows = readdirSync(join(jobsDir, "waitlist"));
  expect(rows).toHaveLength(3);
  // Rows carry no raw user id — the filename segment is a hash.
  expect(rows.every((r) => !r.includes("user-a") && !r.includes("user-b"))).toBe(true);
});

test("rejects garbage language tags", async () => {
  expect((await waitlistPost(join_("user-a", "german!"))).status).toBe(400);
  expect((await waitlistPost(join_("user-a", "../../etc"))).status).toBe(400);
  expect((await waitlistPost(join_("user-a", ""))).status).toBe(400);
  expect((await waitlistPost(join_("user-a", undefined))).status).toBe(400);
  expect(existsSync(join(jobsDir, "waitlist"))).toBe(false);
});

test("first join emits a waitlist-joined event with hashed user", async () => {
  await waitlistPost(join_("user-a", "de"));
  await waitlistPost(join_("user-a", "de")); // deduped, no second event

  const lines = readFileSync(join(jobsDir, "events.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  const event = JSON.parse(lines[0]!);
  expect(event.type).toBe("waitlist-joined");
  expect(event.language).toBe("de");
  expect(event.user).toBeDefined();
  expect(JSON.stringify(event)).not.toContain("user-a");
});
