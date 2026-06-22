import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseEpub } from "@/lib/core/epub";
import { hashSource, findBySourceHash } from "@/lib/core/library";
import { loadConfig } from "@/lib/server/config";
import { jobDirFor, cacheState } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
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
    return Response.json({ error: `Érvénytelen EPUB: ${(err as Error).message}` }, { status: 400 });
  }

  // Household library dedup: an identical book is already translated — don't redo it.
  const existing = findBySourceHash(config.libraryDir, hashSource(bytes));
  if (existing) {
    return Response.json({
      id: existing.id,
      title: existing.title,
      spineItemCount,
      provider: config.providerName,
      alreadyTranslated: true,
    });
  }

  const id = crypto.randomUUID();
  const jobDir = jobDirFor(config, id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "source.epub"), bytes);

  cacheState({
    id,
    status: "pending",
    provider: config.providerName,
    title,
    words: 0,
    spineItemCount,
    chunks: { total: 0, done: 0 },
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, ceilingUsd: config.costCeilingUsd },
  });

  return Response.json({ id, title, spineItemCount, provider: config.providerName });
}
