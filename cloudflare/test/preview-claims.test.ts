import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { applyMigrations } from "./migrations";

import { UserDataRepository } from "../src/database";
import { HttpError } from "../src/security";
import type { JobRow } from "../src/types";

const USER = "a".repeat(64);
const SOURCE = "1".repeat(64);
const OTHER_SOURCE = "2".repeat(64);
/** Distinct job ids for the same book: every attempt is its own upload. */
const JOB = (n: number) => `018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a0${n}0`;

let database: Database;
let d1: D1Database;

beforeEach(async () => {
  database = new Database(":memory:", { strict: true });
  await applyMigrations(database);
  d1 = sqliteD1(database);
  const now = new Date().toISOString();
  database.query("INSERT INTO accounts VALUES (?, ?, ?)").run(USER, now, now);
  database.query("INSERT INTO credit_accounts VALUES (?, 100, 0, 0, ?)").run(USER, now);
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
          return { results: statement.all(...values as never[]) as T[], success: true, meta: {} };
        },
        async run() {
          const result = statement.run(...values as never[]);
          return { results: [], success: true, meta: { changes: result.changes } };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}

/** A sample upload for `source`, delivered or not. */
function sampleJob(jobId: string, source = SOURCE, withResult = false): JobRow {
  const now = new Date().toISOString();
  database.query(`
    INSERT INTO jobs (
      id, user_id, status, source_key, result_key, provider, target_language,
      sample, source_hash, spine_item_count, source_characters,
      required_credits, quote_version, created_at, updated_at, expires_at
    ) VALUES (?, ?, 'pending', ?, ?, 'gemini', 'hu', 1, ?, 1, 1000, 0,
      'source-chars-v1', ?, ?, ?)
  `).run(
    jobId,
    USER,
    `users/${USER}/jobs/${jobId}/source.epub`,
    withResult ? `users/${USER}/jobs/${jobId}/result.epub` : null,
    source,
    now,
    now,
    "2099-01-01T00:00:00.000Z",
  );
  return { id: jobId, user_id: USER, source_hash: source } as JobRow;
}

describe("free chapter claims", () => {
  test("takes the free chapter the first time and holds it for that job", async () => {
    const repository = new UserDataRepository(d1, USER);
    const job = sampleJob(JOB(1));

    expect(await repository.claimJobPreview(job)).toBe(true);
    // A retry of the same upload is the same claim, not a second one.
    expect(await repository.claimJobPreview(job)).toBe(true);
  });

  test("keeps the claim spent while the earlier sample can still be downloaded", async () => {
    const repository = new UserDataRepository(d1, USER);
    await repository.claimJobPreview(sampleJob(JOB(1), SOURCE, true));

    // Nothing was lost, so there is nothing to give back.
    expect(await repository.claimJobPreview(sampleJob(JOB(2)))).toBe(false);
  });

  test("gives the free chapter back once the delivered sample is gone", async () => {
    const repository = new UserDataRepository(d1, USER);
    await repository.claimJobPreview(sampleJob(JOB(1)));

    expect(await repository.claimJobPreview(sampleJob(JOB(2)))).toBe(true);
    // One book still holds exactly one claim, now pointing at the new job so a
    // failed run refunds the right one.
    expect(database.query(
      "SELECT job_id FROM preview_claims WHERE user_id = ? AND source_hash = ?",
    ).get(USER, SOURCE)).toEqual({ job_id: JOB(2) });
  });

  test("stops the delete-and-claim loop at three in a week", async () => {
    const repository = new UserDataRepository(d1, USER);
    await repository.claimJobPreview(sampleJob(JOB(1)));

    for (const attempt of [2, 3, 4]) {
      expect(await repository.claimJobPreview(sampleJob(JOB(attempt)))).toBe(true);
    }

    const fourth = repository.claimJobPreview(sampleJob(JOB(5)));
    await expect(fourth).rejects.toThrow(HttpError);
    await expect(fourth).rejects.toMatchObject({ status: 429, code: "preview_reclaim_limit" });
  });

  test("does not spend the weekly ceiling on a book sampled for the first time", async () => {
    const repository = new UserDataRepository(d1, USER);
    await repository.claimJobPreview(sampleJob(JOB(1)));
    for (const attempt of [2, 3, 4]) {
      await repository.claimJobPreview(sampleJob(JOB(attempt)));
    }

    // A different book has never been sampled: the ceiling is for taking a
    // chapter back, not for tasting a new one.
    expect(await repository.claimJobPreview(sampleJob(JOB(6), OTHER_SOURCE))).toBe(true);
  });
});
