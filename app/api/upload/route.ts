import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseEpub } from "@/lib/core/epub";
import { createCostState } from "@/lib/core/cost";
import type { JobState } from "@/lib/core/job";
import { hashSource, findBySourceHash } from "@/lib/core/library";
import { loadConfig } from "@/lib/server/config";
import {
  ENTITLEMENT_LANGUAGES,
  hasTranslationEntitlement,
} from "@/lib/server/entitlements";
import { appendEvent } from "@/lib/server/events";
import { jobDirFor, cacheState } from "@/lib/server/jobs";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const form = await req.formData();
  const file = form.get("epub");
  if (!(file instanceof File)) {
    return Response.json({ error: "Hiányzik az EPUB fájl." }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let title: string | undefined;
  let spineItemCount: number;
  try {
    const epub = parseEpub(bytes);
    title = epub.title;
    spineItemCount = epub.spine.length;
  } catch (err) {
    // T18 failure bucket: import-broken cohorts must be visible as a
    // denominator, not masquerade as a conversion failure.
    appendEvent(config, {
      type: "import-failed",
      userId: ctx.userId,
      detail: (err as Error).message.slice(0, 120),
    });
    return Response.json({ error: `Érvénytelen EPUB: ${(err as Error).message}` }, { status: 400 });
  }

  const sourceHash = hashSource(bytes);
  // Entitlement restore by re-upload (eng D11 / E5): consumables have no
  // Apple-side restore, so the server entitlement row IS the restore. The
  // client reads entitledLanguages and offers the full translation at no
  // charge instead of asking the user to pay again after a reinstall.
  const entitledLanguages = ENTITLEMENT_LANGUAGES.filter((lang) =>
    hasTranslationEntitlement(config, ctx.userId, sourceHash, lang),
  );

  // User-scoped dedup: an identical book is already translated for this user — don't redo it.
  const existing = findBySourceHash(config.libraryDir, sourceHash, ctx.userId);
  if (existing) {
    return Response.json({
      id: existing.id,
      title: existing.title,
      spineItemCount,
      provider: config.providerName,
      alreadyTranslated: true,
      entitledLanguages,
    });
  }

  const id = crypto.randomUUID();
  const jobDir = jobDirFor(config, id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "source.epub"), bytes);

  const state: JobState = {
    id,
    status: "pending",
    provider: config.providerName,
    title,
    userId: ctx.userId,
    sourceHash,
    words: 0,
    spineItemCount,
    chunks: { total: 0, done: 0 },
    cost: createCostState(config.costCeilingUsd),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(jobDir, "manifest.json"), JSON.stringify(state, null, 2));
  cacheState(state);

  return Response.json({
    id,
    title,
    spineItemCount,
    provider: config.providerName,
    entitledLanguages,
  });
}
