// Retry with exponential backoff + a per-attempt timeout. A whole-book job is hundreds
// of provider calls, so transient 5xx / 429 / network hangs are expected; one of them
// must not abort the run. Retryable errors back off (honoring Retry-After when present);
// non-retryable errors (4xx other than 429) fail fast. `sleep` is injectable for tests.

/** A transient failure worth retrying. `retryAfterMs` overrides the backoff when set. */
export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
  }
}

export interface RetryOptions {
  /** Max retries AFTER the first attempt (default 4 → up to 5 tries). */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt timeout; aborts the attempt's signal (default 120s). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (err: unknown) => boolean;
}

/** Retry on explicit RetryableError, request timeouts (AbortError), and fetch network errors. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (err instanceof TypeError) return true; // fetch network failure
  }
  return false;
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const shouldRetry = opts.shouldRetry ?? isRetryable;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) throw err;
      const retryAfter = err instanceof RetryableError ? err.retryAfterMs : undefined;
      const backoff = Math.min(max, base * 2 ** attempt);
      await sleep(retryAfter ?? backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Parse an HTTP `Retry-After` header (seconds, or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
