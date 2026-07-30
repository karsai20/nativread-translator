import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { applyMigrations } from "./migrations";

let database: Database;

beforeEach(async () => {
  database = new Database(":memory:", { strict: true });
  await applyMigrations(database);
});

afterEach(() => database.close());

function insertAccount(userId = "a".repeat(64)) {
  const now = new Date().toISOString();
  database.query("INSERT INTO accounts VALUES (?, ?, ?)").run(userId, now, now);
  database.query("INSERT INTO credit_accounts VALUES (?, 100, 0, 0, ?)").run(userId, now);
  return { userId, now };
}

function insertJob(
  userId: string,
  now: string,
  status = "pending",
  jobId = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a021",
  requiredCredits = 1,
) {
  database.query(`
    INSERT INTO jobs (
      id, user_id, status, source_key, provider, target_language, sample,
      source_hash, spine_item_count, source_characters, required_credits,
      quote_version, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, 'gemini', 'hu', 0, ?, 1, 1000, ?, 'source-chars-v1', ?, ?, ?)
  `).run(
    jobId,
    userId,
    status,
    `users/${userId}/jobs/${jobId}/source.epub`,
    "b".repeat(64),
    requiredCredits,
    now,
    now,
    now,
  );
}

function insertBookPurchase(
  userId: string,
  now: string,
  transactionId = "2000000900000001",
  sourceHash = "b".repeat(64),
) {
  return database.query(`
    INSERT INTO book_purchases
      (transaction_id, user_id, product_id, source_hash, target_language, environment, created_at)
    VALUES (?, ?, 'com.karsai.nativread.book.t3', ?, 'hu', 'Sandbox', ?)
    ON CONFLICT(transaction_id) DO NOTHING
  `).run(transactionId, userId, sourceHash, now);
}

describe("D1 schema invariants", () => {
  test("a recorded purchase grants its entitlement in the same statement", () => {
    const { userId, now } = insertAccount();
    insertBookPurchase(userId, now);

    expect(database.query(
      "SELECT source_hash, target_language FROM entitlements WHERE user_id = ?",
    ).get(userId)).toEqual({ source_hash: "b".repeat(64), target_language: "hu" });
  });

  test("a replayed transaction id cannot grant a second entitlement", () => {
    const { userId, now } = insertAccount();
    insertBookPurchase(userId, now);
    const replay = insertBookPurchase(userId, now, "2000000900000001", "c".repeat(64));

    expect(replay.changes).toBe(0);
    expect(database.query(
      "SELECT COUNT(*) AS count FROM entitlements WHERE user_id = ?",
    ).get(userId)).toEqual({ count: 1 });
  });

  test("purchases and their entitlements disappear with the account", () => {
    const { userId, now } = insertAccount();
    insertBookPurchase(userId, now);
    database.query("DELETE FROM accounts WHERE user_id = ?").run(userId);

    expect(database.query("SELECT COUNT(*) AS count FROM book_purchases").get())
      .toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM entitlements").get())
      .toEqual({ count: 0 });
  });

  test("prevents overspending at the database layer", () => {
    const { userId } = insertAccount();
    expect(() => database.query(
      "UPDATE credit_accounts SET reserved_credits = 101 WHERE user_id = ?",
    ).run(userId)).toThrow();
    expect(() => database.query(
      "UPDATE credit_accounts SET spent_credits = -1 WHERE user_id = ?",
    ).run(userId)).toThrow();
  });

  test("rejects invalid job state and cross-table orphaning", () => {
    const { userId, now } = insertAccount();
    expect(() => insertJob(userId, now, "hacked")).toThrow();
    insertJob(userId, now);
    database.query("DELETE FROM accounts WHERE user_id = ?").run(userId);
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get() as { count: number })
      .toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM credit_accounts").get() as { count: number })
      .toEqual({ count: 0 });
  });

  test("allows only one preview claim per account and source", () => {
    const { userId, now } = insertAccount();
    insertJob(userId, now);
    database.query(
      "INSERT INTO preview_claims (user_id, source_hash, job_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(userId, "b".repeat(64), "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a021", now);
    expect(() => database.query(
      "INSERT INTO preview_claims (user_id, source_hash, job_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(userId, "b".repeat(64), "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a021", now)).toThrow();
  });

  test("stores one immutable clickwrap acceptance per account, book and terms version", () => {
    const { userId, now } = insertAccount();
    const jobId = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a021";
    insertJob(userId, now, "pending", jobId);
    const insert = database.query(`
      INSERT INTO terms_acceptances (
        acceptance_id, user_id, job_id, source_hash, terms_version,
        statement_version, acceptance_method, client_accepted_at,
        server_accepted_at, locale, terms_document_url
      ) VALUES (?, ?, ?, ?, '2026-07-22', '2026-07-22', 'ios-clickwrap', ?, ?, 'hu-HU', ?)
    `);
    insert.run(
      "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a099",
      userId,
      jobId,
      "b".repeat(64),
      now,
      now,
      "https://nativread.com/terms/2026-07-22/",
    );
    expect(() => insert.run(
      "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a098",
      userId,
      jobId,
      "b".repeat(64),
      now,
      now,
      "https://nativread.com/terms/2026-07-22/",
    )).toThrow();
    database.query("DELETE FROM accounts WHERE user_id = ?").run(userId);
    expect(database.query("SELECT COUNT(*) AS count FROM terms_acceptances").get())
      .toEqual({ count: 0 });
  });

  test("makes credit reservation idempotent and settles through database triggers", () => {
    const { userId, now } = insertAccount();
    const jobId = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a021";
    insertJob(userId, now, "pending", jobId, 40);
    const reserve = database.query(`
      INSERT INTO credit_reservations
        (job_id, user_id, source_hash, credits, quote_version, status, reserved_at)
      VALUES (?, ?, ?, 40, 'source-chars-v1', 'reserved', ?)
      ON CONFLICT(job_id) DO NOTHING
    `);
    reserve.run(jobId, userId, "b".repeat(64), now);
    reserve.run(jobId, userId, "b".repeat(64), now);
    expect(database.query(
      "SELECT reserved_credits, spent_credits FROM credit_accounts WHERE user_id = ?",
    ).get(userId)).toEqual({ reserved_credits: 40, spent_credits: 0 });

    database.query(
      "UPDATE credit_reservations SET status = 'finalized', settled_at = ? WHERE job_id = ?",
    ).run(now, jobId);
    expect(database.query(
      "SELECT reserved_credits, spent_credits FROM credit_accounts WHERE user_id = ?",
    ).get(userId)).toEqual({ reserved_credits: 0, spent_credits: 40 });
  });

  test("rolls back an unaffordable reservation at the database boundary", () => {
    const { userId, now } = insertAccount();
    const jobId = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a022";
    insertJob(userId, now, "pending", jobId, 101);
    expect(() => database.query(`
      INSERT INTO credit_reservations
        (job_id, user_id, source_hash, credits, quote_version, status, reserved_at)
      VALUES (?, ?, ?, 101, 'source-chars-v1', 'reserved', ?)
    `).run(jobId, userId, "b".repeat(64), now)).toThrow();
    expect(database.query(
      "SELECT COUNT(*) AS count FROM credit_reservations WHERE job_id = ?",
    ).get(jobId)).toEqual({ count: 0 });
    expect(database.query(
      "SELECT reserved_credits FROM credit_accounts WHERE user_id = ?",
    ).get(userId)).toEqual({ reserved_credits: 0 });
  });

  test("global AI budget reservations fail closed and cascade on account deletion", () => {
    const { userId, now } = insertAccount();
    const firstJob = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a031";
    const secondJob = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a032";
    const thirdJob = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a033";
    insertJob(userId, now, "pending", firstJob);
    insertJob(userId, now, "pending", secondJob);
    insertJob(userId, now, "pending", thirdJob);
    const day = "2026-07-22";
    database.query(
      "INSERT INTO ai_budget_reservations VALUES (?, ?, 1000, 0, 'reserved', ?, NULL)",
    ).run(firstJob, day, now);
    database.query(
      "INSERT INTO ai_budget_reservations VALUES (?, ?, 1000, 300, 'finalized', ?, ?)",
    ).run(secondJob, day, now, now);

    const guardedInsert = database.query(`
      INSERT INTO ai_budget_reservations
        (job_id, budget_day, reserved_cents, actual_cents, status, created_at, settled_at)
      SELECT ?, ?, 1000, 0, 'reserved', ?, NULL
      WHERE (SELECT COALESCE(SUM(CASE WHEN status = 'finalized' THEN actual_cents
        WHEN status = 'reserved' THEN reserved_cents ELSE 0 END), 0) FROM ai_budget_reservations
        WHERE budget_day = ?) + 1000 <= 2000
      AND (SELECT COALESCE(SUM(CASE WHEN status = 'finalized' THEN actual_cents
        WHEN status = 'reserved' THEN reserved_cents ELSE 0 END), 0) FROM ai_budget_reservations
        WHERE substr(budget_day, 1, 7) = ? AND job_id <> ?) + 1000 <= 100000
    `);
    expect(guardedInsert.run(thirdJob, day, now, day, "2026-07", thirdJob).changes).toBe(0);

    database.query(
      "UPDATE ai_budget_reservations SET status = 'refunded', settled_at = ? WHERE job_id = ?",
    ).run(now, firstJob);
    expect(guardedInsert.run(thirdJob, day, now, day, "2026-07", thirdJob).changes).toBe(1);

    database.query("DELETE FROM accounts WHERE user_id = ?").run(userId);
    expect(database.query("SELECT COUNT(*) AS count FROM ai_budget_reservations").get())
      .toEqual({ count: 0 });
  });

  test("global AI budget counts finalized spend across the whole UTC month", () => {
    const { userId, now } = insertAccount();
    const previousJob = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a041";
    const nextJob = "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a042";
    insertJob(userId, now, "done", previousJob);
    insertJob(userId, now, "pending", nextJob);
    database.query(
      "INSERT INTO ai_budget_reservations VALUES (?, '2026-07-01', 2300, 2300, 'finalized', ?, ?)",
    ).run(previousJob, now, now);

    const result = database.query(`
      INSERT INTO ai_budget_reservations
        (job_id, budget_day, reserved_cents, actual_cents, status, created_at, settled_at)
      SELECT ?, '2026-07-22', 300, 0, 'reserved', ?, NULL
      WHERE (SELECT COALESCE(SUM(CASE WHEN status = 'finalized' THEN actual_cents
        WHEN status = 'reserved' THEN reserved_cents ELSE 0 END), 0)
        FROM ai_budget_reservations WHERE substr(budget_day, 1, 7) = '2026-07')
        + 300 <= 2500
    `).run(nextJob, now);
    expect(result.changes).toBe(0);
  });
});
