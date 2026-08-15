import { createSessionToken, SESSION_TTL_SECONDS, verifySessionToken } from "../../lib/server/session";
import { oidcProvidersFromConfig, verifyIdToken } from "../../lib/server/oidc";

import type { Env } from "./types";

const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function securityHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return headers;
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = securityHeaders(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return json(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        requestId,
      },
      { status: error.status },
    );
  }
  console.error(JSON.stringify({ event: "request-error", requestId, error: safeError(error) }));
  return json({ error: "Átmeneti szerverhiba.", requestId }, { status: 500 });
}

export function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : String(error).slice(0, 400);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  return match?.[1] ?? null;
}

export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const input = bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : Uint8Array.from(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSubject(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

/**
 * The UUID the app attaches to a StoreKit purchase, derived from the account id
 * so it needs neither storage nor a schema column. It binds the receipt to the
 * buyer: a transaction id lifted from someone else's device carries their token,
 * not this account's, and is refused before it can grant anything.
 *
 * The account id is already a SHA-256 hash, so this exposes nothing new.
 */
export function appAccountTokenFor(userId: string): string {
  const hex = userId.slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function requestId(request: Request): string {
  const provided = request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? "";
  return /^[A-Za-z0-9._:-]{1,80}$/u.test(provided) ? provided : crypto.randomUUID();
}

export async function identityFromAppleToken(token: string, env: Env) {
  const audiences = csv(env.APPLE_CLIENT_IDS);
  if (audiences.length === 0) throw new HttpError(503, "Az Apple-bejelentkezés nincs beállítva.");
  const identity = await verifyIdToken(
    token,
    oidcProvidersFromConfig({ appleClientIds: audiences }),
  );
  if (!identity || identity.provider !== "apple") {
    throw new HttpError(401, "Érvénytelen Apple-azonosító.");
  }
  return {
    userId: await sha256(identity.userId),
    audience: identity.audience,
  };
}

/**
 * The configured session secret, or a 503. Callers must go through this before
 * using SESSION_SECRET for anything — including the auth rate-limit subject,
 * where an unset secret would otherwise surface as an opaque 500.
 */
export function sessionSecret(env: Env): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new HttpError(503, "A munkamenet-hitelesítés nincs beállítva.");
  }
  return env.SESSION_SECRET;
}

export async function mintSession(userId: string, env: Env): Promise<{ token: string; expiresIn: number }> {
  return {
    token: await createSessionToken(userId, sessionSecret(env)),
    expiresIn: SESSION_TTL_SECONDS,
  };
}

export async function requireUser(request: Request, env: Env): Promise<string> {
  if (env.ENVIRONMENT !== "production" && env.ALLOW_DEV_AUTH === "1") {
    const devIdentity = request.headers.get("x-nativread-user-id")?.trim() ?? "";
    if (/^[A-Za-z0-9._:@-]{1,128}$/u.test(devIdentity)) {
      const userId = await sha256(`dev:${devIdentity}`);
      await ensureAccount(env.DB, userId);
      return userId;
    }
  }

  const token = bearerToken(request);
  if (!token || !env.SESSION_SECRET) throw new HttpError(401, "Jelentkezz be az Apple-lel.");
  const userId = await verifySessionToken(token, env.SESSION_SECRET);
  if (!userId || !/^[a-f0-9]{64}$/u.test(userId)) {
    throw new HttpError(401, "A munkamenet lejárt. Jelentkezz be újra.");
  }
  const account = await env.DB.prepare("SELECT 1 AS ok FROM accounts WHERE user_id = ?")
    .bind(userId)
    .first<{ ok: number }>();
  if (!account) throw new HttpError(401, "A munkamenet már nem érvényes.");
  return userId;
}

/** Best-effort abuse trail. The hourly retention sweep prunes it. */
export async function recordSecurityEvent(
  db: D1Database,
  userId: string | null,
  eventType: string,
  detail: string,
): Promise<void> {
  await db.prepare(
    "INSERT INTO security_events (user_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)",
  ).bind(userId, eventType, detail.slice(0, 400), new Date().toISOString()).run();
}

export async function ensureAccount(db: D1Database, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "INSERT INTO accounts (user_id, created_at, last_login_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET last_login_at = excluded.last_login_at",
    ).bind(userId, now, now),
    db.prepare(
      "INSERT OR IGNORE INTO credit_accounts " +
      "(user_id, purchased_credits, reserved_credits, spent_credits, updated_at) VALUES (?, 0, 0, 0, ?)",
    ).bind(userId, now),
  ]);
}

export async function enforceRateLimit(
  db: D1Database,
  subject: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
  exhausted: { message: string; code: string } = {
    message: "Túl sok kérés. Próbáld újra később.",
    code: "rate_limited",
  },
): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = new Date(Math.floor(nowSeconds / windowSeconds) * windowSeconds * 1000).toISOString();
  const row = await db.prepare(
    "INSERT INTO rate_limits (subject, bucket, window_start, count) VALUES (?, ?, ?, 1) " +
    "ON CONFLICT(subject, bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ? " +
    "RETURNING count",
  ).bind(subject, bucket, windowStart, limit).first<{ count: number }>();
  if (!row) throw new HttpError(429, exhausted.message, exhausted.code);
}

export function objectPrefix(userId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(userId)) throw new Error("Invalid internal user id");
  return `users/${userId}/`;
}

export function sourceKey(userId: string, jobId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(jobId)) {
    throw new Error("Invalid job id");
  }
  return `${objectPrefix(userId)}jobs/${jobId}/source.epub`;
}

export function resultKey(userId: string, jobId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(jobId)) {
    throw new Error("Invalid job id");
  }
  return `${objectPrefix(userId)}jobs/${jobId}/result.epub`;
}

export async function parseSmallJson<T>(request: Request, maxBytes = 16 * 1024): Promise<T> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "A kérés túl nagy.");
  }
  if (!request.body) throw new HttpError(400, "Hiányzik a JSON-kérés.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("JSON body limit exceeded");
      throw new HttpError(413, "A kérés túl nagy.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, "Érvénytelen JSON-kérés.");
  }
}
