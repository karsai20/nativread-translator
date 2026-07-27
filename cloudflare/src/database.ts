import type { TermsAcceptanceInput } from "./legal";
import type { Env, JobRow } from "./types";

export const CREDIT_PRODUCTS = [
  { productId: "com.karsai.nativread.credits.250", credits: 250 },
  { productId: "com.karsai.nativread.credits.600", credits: 600 },
  { productId: "com.karsai.nativread.credits.1200", credits: 1_200 },
] as const;

export interface PendingJobInput {
  id: string;
  sourceKey: string;
  provider: string;
  sourceHash: string;
  title: string | null;
  spineItemCount: number;
  sourceCharacters: number;
  requiredCredits: number;
  quoteVersion: string;
  createdAt: string;
  expiresAt: string;
}

export interface AccountJobReference {
  id: string;
  workflow_instance_id: string | null;
}

/**
 * The only D1 capability exposed to authenticated request handlers.
 *
 * Every operation on user-owned data closes over one authenticated user ID.
 * Queue, Workflow and scheduled handlers use the explicitly named internal
 * helpers below instead.
 */
export class UserDataRepository {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {
    if (!/^[a-f0-9]{64}$/u.test(userId)) {
      throw new Error("Invalid authenticated user id");
    }
  }

  private assertOwnedJob(job: JobRow): void {
    if (job.user_id !== this.userId) {
      throw new Error("Cross-tenant job passed to user data repository");
    }
  }

  async job(jobId: string): Promise<JobRow | null> {
    return jobForUser(this.db, jobId, this.userId);
  }

  async completedTranslation(sourceHash: string, targetLanguage: string): Promise<JobRow | null> {
    return this.db.prepare(
      "SELECT * FROM jobs WHERE user_id = ? AND source_hash = ? AND target_language = ? " +
      "AND sample = 0 AND status = 'done' AND result_key IS NOT NULL " +
      "ORDER BY finished_at DESC LIMIT 1",
    ).bind(this.userId, sourceHash, targetLanguage).first<JobRow>();
  }

  async createPendingJob(input: PendingJobInput): Promise<void> {
    const expectedKey = `users/${this.userId}/jobs/${input.id}/source.epub`;
    if (input.sourceKey !== expectedKey) {
      throw new Error("Source object key is outside the authenticated user scope");
    }
    await this.db.prepare(
      "INSERT INTO jobs (id, user_id, status, source_key, provider, target_language, sample, " +
      "source_hash, title, spine_item_count, source_characters, required_credits, quote_version, " +
      "created_at, updated_at, expires_at) VALUES (?, ?, 'pending', ?, ?, 'hu', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      input.id,
      this.userId,
      input.sourceKey,
      input.provider,
      input.sourceHash,
      input.title,
      input.spineItemCount,
      input.sourceCharacters,
      input.requiredCredits,
      input.quoteVersion,
      input.createdAt,
      input.createdAt,
      input.expiresAt,
    ).run();
  }

  async getCreditAccount() {
    return creditAccount(this.db, this.userId);
  }

  async entitled(sourceHash: string, targetLanguage: string): Promise<boolean> {
    return hasEntitlement(this.db, this.userId, sourceHash, targetLanguage);
  }

  async recordAcceptance(
    job: JobRow,
    acceptance: TermsAcceptanceInput,
    env: Pick<Env, "TERMS_VERSION" | "TERMS_DOCUMENT_URL">,
  ): Promise<void> {
    this.assertOwnedJob(job);
    await recordTermsAcceptance(this.db, job, acceptance, env);
  }

  async reserveJobBudget(
    job: JobRow,
    budgetDay: string,
    reservedCents: number,
    dailyCapCents: number,
    monthlyCapCents: number,
  ): Promise<AIBudgetReservationResult> {
    this.assertOwnedJob(job);
    return reserveAIBudget(
      this.db,
      job.id,
      budgetDay,
      reservedCents,
      dailyCapCents,
      monthlyCapCents,
    );
  }

  async releaseJobBudget(jobId: string): Promise<void> {
    await this.db.prepare(
      "UPDATE ai_budget_reservations SET status = 'refunded', actual_cents = 0, settled_at = ? " +
      "WHERE job_id = ? AND status = 'reserved' AND EXISTS (" +
      "SELECT 1 FROM jobs WHERE jobs.id = ai_budget_reservations.job_id AND jobs.user_id = ?)",
    ).bind(new Date().toISOString(), jobId, this.userId).run();
  }

  async reserveJobCredits(job: JobRow): Promise<ReservationResult> {
    this.assertOwnedJob(job);
    return reserveCredits(this.db, job);
  }

  async refundJobCredits(jobId: string): Promise<void> {
    await this.db.prepare(
      "UPDATE credit_reservations SET status = 'refunded', settled_at = ? " +
      "WHERE job_id = ? AND user_id = ? AND status = 'reserved'",
    ).bind(new Date().toISOString(), jobId, this.userId).run();
  }

  async claimJobPreview(job: JobRow): Promise<boolean> {
    this.assertOwnedJob(job);
    return claimPreview(this.db, job);
  }

  async queueJob(
    jobId: string,
    sample: boolean,
    termsVersion: string,
    aiConsentVersion: string,
    aiProvider: string,
    updatedAt: string,
  ): Promise<number> {
    const result = await this.db.prepare(
      "UPDATE jobs SET status = 'queued', sample = ?, target_language = 'hu', terms_version = ?, " +
      "ai_consent_version = ?, ai_provider = ?, error_code = NULL, error_message = NULL, updated_at = ? " +
      "WHERE id = ? AND user_id = ? AND status IN ('pending', 'error', 'cancelled')",
    ).bind(
      sample ? 1 : 0,
      termsVersion,
      aiConsentVersion,
      aiProvider,
      updatedAt,
      jobId,
      this.userId,
    ).run();
    return result.meta.changes ?? 0;
  }

  async markQueueFailed(jobId: string, message: string, updatedAt: string): Promise<void> {
    await this.db.prepare(
      "UPDATE jobs SET status = 'error', error_code = 'queue_failed', error_message = ?, updated_at = ? " +
      "WHERE id = ? AND user_id = ? AND status = 'queued'",
    ).bind(message, updatedAt, jobId, this.userId).run();
  }

  async markResultConsumed(jobId: string, deliveredAt: string): Promise<void> {
    await this.db.prepare(
      "UPDATE jobs SET result_key = NULL, delivered_at = ?, updated_at = ? " +
      "WHERE id = ? AND user_id = ?",
    ).bind(deliveredAt, deliveredAt, jobId, this.userId).run();
  }

  async accountJobs(): Promise<AccountJobReference[]> {
    const jobs = await this.db.prepare(
      "SELECT id, workflow_instance_id FROM jobs WHERE user_id = ?",
    ).bind(this.userId).all<AccountJobReference>();
    return jobs.results;
  }

  async cancelActiveAccountJobs(updatedAt: string): Promise<void> {
    await this.db.prepare(
      "UPDATE jobs SET status = 'cancelled', updated_at = ?, finished_at = ? " +
      "WHERE user_id = ? AND status IN ('pending', 'queued', 'starting', 'running', 'error')",
    ).bind(updatedAt, updatedAt, this.userId).run();
  }

  async deleteAccount(): Promise<void> {
    await this.db.prepare("DELETE FROM accounts WHERE user_id = ?").bind(this.userId).run();
  }
}

async function jobForUser(
  db: D1Database,
  jobId: string,
  userId: string,
): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
    .bind(jobId, userId)
    .first<JobRow>();
}

/**
 * Internal-only lookup for Queue, Workflow and scheduled handlers. Request
 * handlers must use UserDataRepository.job() instead.
 */
export async function internalJobById(db: D1Database, jobId: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
}

async function creditAccount(db: D1Database, userId: string) {
  const row = await db.prepare(
    "SELECT purchased_credits, reserved_credits, spent_credits FROM credit_accounts WHERE user_id = ?",
  ).bind(userId).first<{
    purchased_credits: number;
    reserved_credits: number;
    spent_credits: number;
  }>();
  const purchasedCredits = row?.purchased_credits ?? 0;
  const reservedCredits = row?.reserved_credits ?? 0;
  const spentCredits = row?.spent_credits ?? 0;
  return {
    balance: purchasedCredits - reservedCredits - spentCredits,
    purchasedCredits,
    reservedCredits,
    spentCredits,
  };
}

async function hasEntitlement(
  db: D1Database,
  userId: string,
  sourceHash: string,
  targetLanguage: string,
): Promise<boolean> {
  return Boolean(await db.prepare(
    "SELECT 1 AS ok FROM entitlements WHERE user_id = ? AND source_hash = ? AND target_language = ?",
  ).bind(userId, sourceHash, targetLanguage).first());
}

async function recordTermsAcceptance(
  db: D1Database,
  job: JobRow,
  acceptance: TermsAcceptanceInput,
  env: Pick<Env, "TERMS_VERSION" | "TERMS_DOCUMENT_URL">,
): Promise<void> {
  const serverAcceptedAt = new Date().toISOString();
  await db.prepare(
    "INSERT OR IGNORE INTO terms_acceptances " +
    "(acceptance_id, user_id, job_id, source_hash, terms_version, statement_version, " +
    "acceptance_method, client_accepted_at, server_accepted_at, locale, terms_document_url) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    acceptance.id,
    job.user_id,
    job.id,
    job.source_hash,
    env.TERMS_VERSION,
    acceptance.statementVersion,
    acceptance.method,
    acceptance.acceptedAt,
    serverAcceptedAt,
    acceptance.locale,
    env.TERMS_DOCUMENT_URL,
  ).run();

  const stored = await db.prepare(
    "SELECT acceptance_id, statement_version, acceptance_method, terms_document_url " +
    "FROM terms_acceptances WHERE user_id = ? AND source_hash = ? AND terms_version = ?",
  ).bind(job.user_id, job.source_hash, env.TERMS_VERSION).first<{
    acceptance_id: string;
    statement_version: string;
    acceptance_method: string;
    terms_document_url: string;
  }>();
  if (
    !stored
    || stored.statement_version !== acceptance.statementVersion
    || stored.acceptance_method !== acceptance.method
    || stored.terms_document_url !== env.TERMS_DOCUMENT_URL
  ) {
    throw new Error("Terms acceptance does not match the immutable legal version");
  }
}

export type ReservationResult =
  | { ok: true; alreadyReserved: boolean }
  | { ok: false; balance: number };

export type AIBudgetReservationResult =
  | { ok: true; acquired: boolean }
  | { ok: false };

/**
 * Reserves the configured per-job ceiling against a global UTC-day budget.
 * The INSERT/UPSERT and aggregate guard are one D1 statement, so concurrent
 * accounts cannot each observe the same remaining budget and oversubscribe it.
 */
async function reserveAIBudget(
  db: D1Database,
  jobId: string,
  budgetDay: string,
  reservedCents: number,
  dailyCapCents: number,
  monthlyCapCents: number,
): Promise<AIBudgetReservationResult> {
  const now = new Date().toISOString();
  const reserved = await db.prepare(
    "INSERT INTO ai_budget_reservations " +
    "(job_id, budget_day, reserved_cents, actual_cents, status, created_at, settled_at) " +
    "SELECT ?, ?, ?, 0, 'reserved', ?, NULL " +
    "WHERE (SELECT COALESCE(SUM(CASE WHEN status = 'finalized' THEN actual_cents " +
    "WHEN status = 'reserved' THEN reserved_cents ELSE 0 END), 0) FROM ai_budget_reservations " +
    "WHERE budget_day = ? AND job_id <> ?) + ? <= ? " +
    "AND (SELECT COALESCE(SUM(CASE WHEN status = 'finalized' THEN actual_cents " +
    "WHEN status = 'reserved' THEN reserved_cents ELSE 0 END), 0) FROM ai_budget_reservations " +
    "WHERE substr(budget_day, 1, 7) = ? AND job_id <> ?) + ? <= ? " +
    "ON CONFLICT(job_id) DO UPDATE SET budget_day = excluded.budget_day, " +
    "reserved_cents = excluded.reserved_cents, actual_cents = 0, status = 'reserved', " +
    "created_at = excluded.created_at, settled_at = NULL " +
    "WHERE ai_budget_reservations.status = 'refunded' RETURNING job_id",
  ).bind(
    jobId,
    budgetDay,
    reservedCents,
    now,
    budgetDay,
    jobId,
    reservedCents,
    dailyCapCents,
    budgetDay.slice(0, 7),
    jobId,
    reservedCents,
    monthlyCapCents,
  ).first<{ job_id: string }>();
  if (reserved) return { ok: true, acquired: true };

  const existing = await db.prepare(
    "SELECT status, reserved_cents FROM ai_budget_reservations WHERE job_id = ?",
  ).bind(jobId).first<{ status: string; reserved_cents: number }>();
  if (
    existing
    && (existing.status === "reserved" || existing.status === "finalized")
    && existing.reserved_cents === reservedCents
  ) {
    return { ok: true, acquired: false };
  }
  return { ok: false };
}

export async function finalizeAIBudget(
  db: D1Database,
  jobId: string,
  actualUsd: number,
): Promise<void> {
  const actualCents = Math.max(0, Math.ceil(actualUsd * 100));
  await db.prepare(
    "UPDATE ai_budget_reservations SET status = 'finalized', actual_cents = ?, settled_at = ? " +
    "WHERE job_id = ? AND status = 'reserved'",
  ).bind(actualCents, new Date().toISOString(), jobId).run();
}

/**
 * Internal-only global cleanup. Authenticated request handlers must use
 * UserDataRepository.releaseJobBudget(), which also checks the owning user.
 */
export async function internalReleaseAIBudget(
  db: D1Database,
  jobId: string,
): Promise<void> {
  await db.prepare(
    "UPDATE ai_budget_reservations SET status = 'refunded', actual_cents = 0, settled_at = ? " +
    "WHERE job_id = ? AND status = 'reserved'",
  ).bind(new Date().toISOString(), jobId).run();
}

/**
 * Reserve an immutable upload quote. D1 serializes writes; the unique job row
 * makes concurrent starts idempotent, while the conditional account update
 * prevents the balance from going negative.
 */
async function reserveCredits(db: D1Database, job: JobRow): Promise<ReservationResult> {
  const now = new Date().toISOString();
  try {
    const claimed = await db.prepare(
      "INSERT INTO credit_reservations " +
      "(job_id, user_id, source_hash, credits, quote_version, status, reserved_at) " +
      "VALUES (?, ?, ?, ?, ?, 'reserved', ?) " +
      "ON CONFLICT(job_id) DO UPDATE SET status = 'reserved', reserved_at = excluded.reserved_at, settled_at = NULL " +
      "WHERE credit_reservations.status = 'refunded' " +
      "AND credit_reservations.user_id = excluded.user_id " +
      "AND credit_reservations.source_hash = excluded.source_hash " +
      "AND credit_reservations.credits = excluded.credits " +
      "AND credit_reservations.quote_version = excluded.quote_version " +
      "RETURNING job_id",
    ).bind(
      job.id,
      job.user_id,
      job.source_hash,
      job.required_credits,
      job.quote_version,
      now,
    ).first<{ job_id: string }>();
    if (claimed) return { ok: true, alreadyReserved: false };
  } catch (error) {
    if (String(error).includes("CHECK constraint failed")) {
      return {
        ok: false,
        balance: (await creditAccount(db, job.user_id)).balance,
      };
    }
    throw error;
  }

  const existing = await db.prepare(
    "SELECT user_id, status, credits, source_hash, quote_version " +
    "FROM credit_reservations WHERE job_id = ?",
  ).bind(job.id).first<{
    user_id: string;
    status: string;
    credits: number;
    source_hash: string;
    quote_version: string;
  }>();
  const matches = existing?.user_id === job.user_id
    && existing.credits === job.required_credits
    && existing.source_hash === job.source_hash
    && existing.quote_version === job.quote_version;
  if (!matches || (existing.status !== "reserved" && existing.status !== "finalized")) {
    throw new Error("Credit reservation does not match immutable quote");
  }
  return { ok: true, alreadyReserved: true };
}

async function claimPreview(db: D1Database, job: JobRow): Promise<boolean> {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO preview_claims (user_id, source_hash, job_id, created_at) VALUES (?, ?, ?, ?)",
  ).bind(job.user_id, job.source_hash, job.id, new Date().toISOString()).run();
  if ((result.meta.changes ?? 0) === 1) return true;
  const existing = await db.prepare(
    "SELECT job_id FROM preview_claims WHERE user_id = ? AND source_hash = ?",
  ).bind(job.user_id, job.source_hash).first<{ job_id: string }>();
  return existing?.job_id === job.id;
}

export async function settleSuccess(db: D1Database, job: JobRow): Promise<void> {
  const reservation = await db.prepare(
    "SELECT credits, status FROM credit_reservations WHERE job_id = ?",
  ).bind(job.id).first<{ credits: number; status: string }>();
  const now = new Date().toISOString();
  if (reservation?.status === "reserved") {
    const settled = await db.prepare(
      "UPDATE credit_reservations SET status = 'finalized', settled_at = ? " +
      "WHERE job_id = ? AND status = 'reserved'",
    ).bind(now, job.id).run();
    if ((settled.meta.changes ?? 0) === 1) {
      await db.prepare(
        "INSERT OR IGNORE INTO entitlements (user_id, source_hash, target_language, created_at) VALUES (?, ?, ?, ?)",
      ).bind(job.user_id, job.source_hash, job.target_language, now).run();
    }
  } else if (reservation?.status === "finalized") {
    await db.prepare(
      "INSERT OR IGNORE INTO entitlements (user_id, source_hash, target_language, created_at) VALUES (?, ?, ?, ?)",
    ).bind(job.user_id, job.source_hash, job.target_language, now).run();
  } else if (!job.sample) {
    await db.prepare(
      "INSERT OR IGNORE INTO entitlements (user_id, source_hash, target_language, created_at) VALUES (?, ?, ?, ?)",
    ).bind(job.user_id, job.source_hash, job.target_language, now).run();
  }
}

/**
 * Internal-only global cleanup. Authenticated request handlers must use
 * UserDataRepository.refundJobCredits(), which includes the user_id predicate.
 */
export async function internalRefundReservation(db: D1Database, jobId: string): Promise<void> {
  const reservation = await db.prepare(
    "SELECT user_id, credits, status FROM credit_reservations WHERE job_id = ?",
  ).bind(jobId).first<{ user_id: string; credits: number; status: string }>();
  if (reservation?.status !== "reserved") return;
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE credit_reservations SET status = 'refunded', settled_at = ? " +
    "WHERE job_id = ? AND status = 'reserved'",
  ).bind(now, jobId).run();
}
