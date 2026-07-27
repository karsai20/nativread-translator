import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { UserDataRepository } from "../src/database";
import type { JobRow } from "../src/types";

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const JOB_A = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a0a1";
const JOB_B = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a0b1";
const DONE_JOB_B = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a0b2";
const SOURCE_A = "1".repeat(64);
const SOURCE_B = "2".repeat(64);

let database: Database;
let d1: D1Database;

beforeEach(async () => {
  database = new Database(":memory:", { strict: true });
  database.exec(await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text());
  database.exec(await Bun.file(new URL("../migrations/0002_terms_acceptances.sql", import.meta.url)).text());
  database.exec(await Bun.file(new URL("../migrations/0003_ai_budget_reservations.sql", import.meta.url)).text());
  d1 = sqliteD1(database);

  insertAccount(USER_A);
  insertAccount(USER_B);
  insertJob(USER_A, JOB_A, SOURCE_A, "pending");
  insertJob(USER_B, JOB_B, SOURCE_B, "pending");
  insertJob(USER_B, DONE_JOB_B, SOURCE_B, "done", true);
});

afterEach(() => database.close());

function sqliteD1(sqlite: Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.query(sql);
      let values: unknown[] = [];
      const prepared = {
        bind(...bound: unknown[]) {
          values = bound;
          return prepared;
        },
        async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
          const row = statement.get(...values as never[]) as Record<string, unknown> | null;
          if (!row) return null;
          return (columnName ? row[columnName] : row) as T;
        },
        async all<T = Record<string, unknown>>() {
          return {
            results: statement.all(...values as never[]) as T[],
            success: true,
            meta: {},
          };
        },
        async run() {
          const result = statement.run(...values as never[]);
          return {
            results: [],
            success: true,
            meta: { changes: result.changes },
          };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}

function insertAccount(userId: string): void {
  const now = new Date().toISOString();
  database.query("INSERT INTO accounts VALUES (?, ?, ?)").run(userId, now, now);
  database.query("INSERT INTO credit_accounts VALUES (?, 100, 0, 0, ?)").run(userId, now);
}

function insertJob(
  userId: string,
  jobId: string,
  sourceHash: string,
  status: JobRow["status"],
  withResult = false,
): void {
  const now = new Date().toISOString();
  database.query(`
    INSERT INTO jobs (
      id, user_id, status, source_key, result_key, provider, target_language,
      sample, source_hash, spine_item_count, source_characters,
      required_credits, quote_version, created_at, updated_at, finished_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, 'gemini', 'hu', 0, ?, 1, 1000, 25,
      'source-chars-v1', ?, ?, ?, ?)
  `).run(
    jobId,
    userId,
    status,
    `users/${userId}/jobs/${jobId}/source.epub`,
    withResult ? `users/${userId}/jobs/${jobId}/result.epub` : null,
    sourceHash,
    now,
    now,
    status === "done" ? now : null,
    "2099-01-01T00:00:00.000Z",
  );
}

describe("authenticated D1 tenant boundary", () => {
  test("cannot read or mutate another account's jobs even with known job IDs", async () => {
    const userA = new UserDataRepository(d1, USER_A);

    expect(await userA.job(JOB_B)).toBeNull();
    expect(await userA.completedTranslation(SOURCE_B, "hu")).toBeNull();
    expect(await userA.queueJob(
      JOB_B,
      false,
      "2026-07-22",
      "2026-07-20-gemini",
      "Google Gemini API",
      new Date().toISOString(),
    )).toBe(0);

    await userA.markQueueFailed(JOB_B, "should not apply", new Date().toISOString());
    await userA.markResultConsumed(DONE_JOB_B, new Date().toISOString());

    expect(database.query(
      "SELECT status, error_code FROM jobs WHERE id = ?",
    ).get(JOB_B)).toEqual({ status: "pending", error_code: null });
    expect(database.query(
      "SELECT result_key FROM jobs WHERE id = ?",
    ).get(DONE_JOB_B)).toEqual({
      result_key: `users/${USER_B}/jobs/${DONE_JOB_B}/result.epub`,
    });
  });

  test("cannot refund another account's credits or AI budget", async () => {
    const now = new Date().toISOString();
    database.query(`
      INSERT INTO credit_reservations
        (job_id, user_id, source_hash, credits, quote_version, status, reserved_at)
      VALUES (?, ?, ?, 25, 'source-chars-v1', 'reserved', ?)
    `).run(JOB_B, USER_B, SOURCE_B, now);
    database.query(
      "INSERT INTO ai_budget_reservations VALUES (?, '2026-07-23', 300, 0, 'reserved', ?, NULL)",
    ).run(JOB_B, now);

    const userA = new UserDataRepository(d1, USER_A);
    await userA.refundJobCredits(JOB_B);
    await userA.releaseJobBudget(JOB_B);

    expect(database.query(
      "SELECT status FROM credit_reservations WHERE job_id = ?",
    ).get(JOB_B)).toEqual({ status: "reserved" });
    expect(database.query(
      "SELECT status FROM ai_budget_reservations WHERE job_id = ?",
    ).get(JOB_B)).toEqual({ status: "reserved" });
  });

  test("account cancellation and deletion stay inside the authenticated account", async () => {
    const userA = new UserDataRepository(d1, USER_A);

    expect(await userA.accountJobs()).toEqual([
      { id: JOB_A, workflow_instance_id: null },
    ]);
    await userA.cancelActiveAccountJobs(new Date().toISOString());
    expect(database.query("SELECT status FROM jobs WHERE id = ?").get(JOB_A))
      .toEqual({ status: "cancelled" });
    expect(database.query("SELECT status FROM jobs WHERE id = ?").get(JOB_B))
      .toEqual({ status: "pending" });

    await userA.deleteAccount();
    expect(database.query("SELECT COUNT(*) AS count FROM accounts WHERE user_id = ?").get(USER_A))
      .toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM accounts WHERE user_id = ?").get(USER_B))
      .toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM jobs WHERE user_id = ?").get(USER_B))
      .toEqual({ count: 2 });
  });

  test("rejects a cross-tenant JobRow passed to scoped financial helpers", async () => {
    const userA = new UserDataRepository(d1, USER_A);
    const userB = new UserDataRepository(d1, USER_B);
    const foreignJob = await userB.job(JOB_B);
    expect(foreignJob).not.toBeNull();

    await expect(userA.claimJobPreview(foreignJob!))
      .rejects.toThrow("Cross-tenant job");
    await expect(userA.reserveJobCredits(foreignJob!))
      .rejects.toThrow("Cross-tenant job");
  });

  test("request handlers cannot issue raw D1 statements or call internal helpers", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const start = source.indexOf("async function authApple");
    const end = source.indexOf("async function consumeQueue");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const requestHandlers = source.slice(start, end);

    expect(requestHandlers).not.toContain("env.DB.prepare(");
    expect(requestHandlers).not.toContain("env.DB.batch(");
    expect(requestHandlers).not.toMatch(/\binternal[A-Z][A-Za-z]+\(/u);
  });
});
