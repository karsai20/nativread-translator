// In-app language waitlist (CEO D3.4 / E7): "Other language" in the picker
// writes a per-(user, language) metadata row. Dedupe makes it idempotent and
// bounds writes per user; no email, no PII beyond the pseudonymous user id.
// The launch dashboard is one count over these rows.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { loadConfig, type ServerConfig } from "@/lib/server/config";
import { requestContext } from "@/lib/server/request-context";
import { appendEvent } from "@/lib/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// BCP-47-ish primary tag, optionally with one subtag. Anything else is noise.
const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

function waitlistDir(config: ServerConfig): string {
  return join(config.jobsDir, "waitlist");
}

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const body = (await req.json().catch(() => ({}))) as { language?: string };
  const language = body.language?.trim().toLowerCase();
  if (!language || !LANGUAGE_RE.test(language)) {
    return Response.json({ error: "Invalid language tag." }, { status: 400 });
  }

  const userSegment = createHash("sha256").update(ctx.userId).digest("hex");
  const dir = waitlistDir(config);
  const row = join(dir, `${userSegment}.${language}.json`);

  // Idempotent: one row per (user, language), re-posts are a no-op.
  if (existsSync(row)) {
    return Response.json({ ok: true, deduped: true });
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(row, JSON.stringify({ language, createdAt: new Date().toISOString() }));
  appendEvent(config, { type: "waitlist-joined", userId: ctx.userId, language });

  return Response.json({ ok: true });
}
