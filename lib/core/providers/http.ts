// Provider-agnostic HTTP transport: retry with exponential backoff + full jitter,
// per-request timeout via AbortController, and Retry-After support. Retries transient
// failures (429/5xx/network) and fails fast on client errors (4xx except 429).

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  retryStatuses?: number[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_RETRYABLE = [429, 500, 502, 503, 504];

function fullJitter(attempt: number, base: number, cap: number, random: () => number): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(random() * exp);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30000;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const retryable = new Set(opts.retryStatuses ?? DEFAULT_RETRYABLE);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      const isLast = attempt === maxAttempts - 1;
      if (!retryable.has(res.status) || isLast) {
        const body = await res.text().catch(() => "");
        throw new HttpError(res.status, body);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : fullJitter(attempt, base, cap, random);
      await sleep(delay);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;
      lastErr = err;
      if (attempt === maxAttempts - 1) break;
      await sleep(fullJitter(attempt, base, cap, random));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetchWithRetry: attempts exhausted");
}
