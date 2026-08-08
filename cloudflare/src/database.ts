import type { TermsAcceptanceInput } from "./legal";
import type { Env, JobRow } from "./types";
import type { LanguagePair } from "../../lib/core/languages";
import type { TermsRelease } from "./legal";

/**
 * Length-tiered per-book consumables. A book is priced once, at upload, from the
 * source character count the metering pass already produces — Apple product prices
 * are fixed tiers, so the tier is chosen server-side and the device only learns
 * which product to buy.
 *
 * Ordered by ascending limit; `bookTierFor` takes the first tier that fits.
 * Anything above the last tier is refused at upload, because the top tier would
 * stop covering its own translation cost.
 */
export const BOOK_TIERS = [
  { tier: 1, maxSourceCharacters: 150_000, productId: "com.karsai.nativread.book.t1" },
  { tier: 2, maxSourceCharacters: 300_000, productId: "com.karsai.nativread.book.t2" },
  { tier: 3, maxSourceCharacters: 500_000, productId: "com.karsai.nativread.book.t3" },
  { tier: 4, maxSourceCharacters: 800_000, productId: "com.karsai.nativread.book.t4" },
  { tier: 5, maxSourceCharacters: 1_200_000, productId: "com.karsai.nativread.book.t5" },
  { tier: 6, maxSourceCharacters: 3_000_000, productId: "com.karsai.nativread.book.t6" },
] as const;

export type BookTier = (typeof BOOK_TIERS)[number];

/** The tier a book falls into, or undefined when it is longer than the top tier covers. */
export function bookTierFor(sourceCharacters: number): BookTier | undefined {
  return BOOK_TIERS.find((tier) => sourceCharacters <= tier.maxSourceCharacters);
}

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

export interface BookPurchaseInput {
  transactionId: string;
  productId: string;
  environment: "Production" | "Sandbox";
}

export interface BookPurchaseResult {
  applied: boolean;
  /** The transaction id belongs to another account or another book. */
  conflict?: boolean;
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

  async entitled(sourceHash: string, targetLanguage: string): Promise<boolean> {
    return hasEntitlement(this.db, this.userId, sourceHash, targetLanguage);
  }

  async recordAcceptance(
    job: JobRow,
    acceptance: TermsAcceptanceInput,
    release: TermsRelease,
  ): Promise<void> {
    this.assertOwnedJob(job);
    await recordTermsAcceptance(this.db, job, acceptance, release);
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

  /**
   * Record a verified App Store transaction. The primary key on transaction_id
   * makes a replay a no-op, and the AFTER INSERT trigger grants the entitlement
   * in the same statement, so a purchase can never be half-applied.
   */
  async recordBookPurchase(job: JobRow, purchase: BookPurchaseInput): Promise<BookPurchaseResult> {
    this.assertOwnedJob(job);
    // RETURNING, not the affected-row count: the entitlement trigger also writes
    // a row, and how that is counted differs between D1 and a local SQLite.
    const inserted = await this.db.prepare(
      "INSERT INTO book_purchases " +
      "(transaction_id, user_id, product_id, source_hash, target_language, environment, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(transaction_id) DO NOTHING " +
      "RETURNING transaction_id",
    ).bind(
      purchase.transactionId,
      this.userId,
      purchase.productId,
      job.source_hash,
      job.target_language,
      purchase.environment,
      new Date().toISOString(),
    ).first<{ transaction_id: string }>();
    if (inserted) return { applied: true };

    // The transaction id was already spent. Only the same owner buying the same
    // book is a replay; anything else is one account claiming another's receipt.
    const existing = await this.db.prepare(
      "SELECT user_id, source_hash FROM book_purchases WHERE transaction_id = ?",
    ).bind(purchase.transactionId).first<{ user_id: string; source_hash: string }>();
    const isReplay = existing?.user_id === this.userId && existing.source_hash === job.source_hash;
    return isReplay ? { applied: false } : { applied: false, conflict: true };
  }

  async claimJobPreview(job: JobRow): Promise<boolean> {
    this.assertOwnedJob(job);
    return claimPreview(this.db, job);
  }

  async queueJob(
    jobId: string,
    sample: boolean,
    pair: LanguagePair,
    termsVersion: string,
    aiConsentVersion: string,
    aiProvider: string,
    updatedAt: string,
  ): Promise<number> {
    const result = await this.db.prepare(
      "UPDATE jobs SET status = 'queued', sample = ?, source_language = ?, target_language = ?, " +
      "terms_version = ?, ai_consent_version = ?, ai_provider = ?, error_code = NULL, " +
      "error_message = NULL, updated_at = ? " +
      "WHERE id = ? AND user_id = ? AND status IN ('pending', 'error', 'cancelled')",
    ).bind(
      sample ? 1 : 0,
      pair.source,
      pair.target,
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
  release: TermsRelease,
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
    release.version,
    acceptance.statementVersion,
    acceptance.method,
    acceptance.acceptedAt,
    serverAcceptedAt,
    acceptance.locale,
    release.documentUrl,
  ).run();

  const stored = await db.prepare(
    "SELECT acceptance_id, statement_version, acceptance_method, terms_document_url " +
    "FROM terms_acceptances WHERE user_id = ? AND source_hash = ? AND terms_version = ?",
  ).bind(job.user_id, job.source_hash, release.version).first<{
    acceptance_id: string;
    statement_version: string;
    acceptance_method: string;
    terms_document_url: string;
  }>();
  if (
    !stored
    || stored.statement_version !== acceptance.statementVersion
    || stored.acceptance_method !== acceptance.method
    || stored.terms_document_url !== release.documentUrl
  ) {
    throw new Error("Terms acceptance does not match the immutable legal version");
  }
}

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

/**
 * A delivered full translation confirms the entitlement the purchase already
 * granted, so this is a no-op on the normal path. It still runs because a
 * translation may also be produced without a purchase — a self-hosted
 * deployment with REQUIRE_TRANSLATION_ENTITLEMENTS=0 — and that book must stay
 * re-downloadable too. A failed paid job needs no refund: the entitlement
 * survives, so the retry costs the customer nothing.
 */
export async function settleSuccess(db: D1Database, job: JobRow): Promise<void> {
  if (job.sample) return;
  await db.prepare(
    "INSERT OR IGNORE INTO entitlements (user_id, source_hash, target_language, created_at) VALUES (?, ?, ?, ?)",
  ).bind(job.user_id, job.source_hash, job.target_language, new Date().toISOString()).run();
}
