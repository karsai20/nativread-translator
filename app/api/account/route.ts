// Account data export + deletion (T9 / GDPR Arts 15, 17, 20).
// GET returns everything stored about the requesting user as JSON;
// DELETE erases it: jobs, library copies, entitlement rows, transaction
// records, waitlist rows, and the user's lines in the funnel event log.
// Both operate strictly on ctx.userId — no cross-user reach, ever.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { loadConfig, type ServerConfig } from "@/lib/server/config";
import { requestContext } from "@/lib/server/request-context";
import { listJobs, deleteJob } from "@/lib/server/jobs";
import { listLibrary } from "@/lib/core/library";
import { eventsPath } from "@/lib/server/events";
import type { TranslationEntitlement } from "@/lib/server/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function userEntitlements(config: ServerConfig, userId: string): TranslationEntitlement[] {
  const dir = join(config.entitlementsDir, "users", sha256(userId));
  if (!existsSync(dir)) return [];
  const rows: TranslationEntitlement[] = [];
  for (const f of readdirSync(dir)) {
    try {
      rows.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as TranslationEntitlement);
    } catch {
      // Skip corrupt rows rather than failing the export.
    }
  }
  return rows;
}

function userWaitlistRows(config: ServerConfig, userId: string): string[] {
  const dir = join(config.jobsDir, "waitlist");
  if (!existsSync(dir)) return [];
  const prefix = `${sha256(userId)}.`;
  return readdirSync(dir).filter((f) => f.startsWith(prefix));
}

export async function GET(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const jobs = listJobs(config)
    .filter((j) => j.userId === ctx.userId)
    .map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      createdAt: j.createdAt,
      sample: j.sample ?? false,
    }));
  const library = listLibrary(config.libraryDir, ctx.userId).map((e) => ({
    id: e.id,
    title: e.title,
    createdAt: e.createdAt,
    sample: e.sample ?? false,
  }));
  const entitlements = userEntitlements(config, ctx.userId).map((e) => ({
    sourceHash: e.sourceHash,
    targetLanguage: e.targetLanguage,
    productId: e.productId,
    createdAt: e.createdAt,
  }));
  const waitlist = userWaitlistRows(config, ctx.userId).map(
    (f) => f.split(".").slice(1, -1).join("."),
  );

  return Response.json({ userId: ctx.userId, jobs, library, entitlements, waitlist });
}

export async function DELETE(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  // Jobs (cancels a running one) + their same-id library copies.
  const jobs = listJobs(config).filter((j) => j.userId === ctx.userId);
  for (const j of jobs) deleteJob(config, j.id, true);

  // Library entries whose job was already gone.
  for (const e of listLibrary(config.libraryDir, ctx.userId)) {
    rmSync(join(config.libraryDir, e.id), { recursive: true, force: true });
  }

  // Entitlements: the user's row dir, plus transaction records pointing at them.
  // Transaction files are the double-grant guard, but a deleted account has no
  // rows left to double-grant against — GDPR erasure wins.
  rmSync(join(config.entitlementsDir, "users", sha256(ctx.userId)), {
    recursive: true,
    force: true,
  });
  const txDir = join(config.entitlementsDir, "transactions");
  if (existsSync(txDir)) {
    for (const f of readdirSync(txDir)) {
      try {
        const row = JSON.parse(readFileSync(join(txDir, f), "utf8")) as TranslationEntitlement;
        if (row.userId === ctx.userId) rmSync(join(txDir, f), { force: true });
      } catch {
        // Unreadable transaction rows are left in place.
      }
    }
  }

  // Waitlist rows.
  const waitlistDir = join(config.jobsDir, "waitlist");
  for (const f of userWaitlistRows(config, ctx.userId)) {
    rmSync(join(waitlistDir, f), { force: true });
  }

  // Funnel events: drop this user's lines (hashed ids are still personal data).
  const events = eventsPath(config);
  if (existsSync(events)) {
    const userHash = sha256(ctx.userId).slice(0, 16);
    const kept = readFileSync(events, "utf8")
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return (JSON.parse(line) as { user?: string }).user !== userHash;
        } catch {
          return true;
        }
      });
    writeFileSync(events, kept.length ? kept.join("\n") + "\n" : "");
  }

  return Response.json({ ok: true, deletedJobs: jobs.length });
}
