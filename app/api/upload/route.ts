import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EpubArchiveLimitError, parseEpub } from "@/lib/core/epub";
import { createCostState } from "@/lib/core/cost";
import type { JobState } from "@/lib/core/job";
import { hashSource, findBySourceHash } from "@/lib/core/library";
import { quoteForEpub, type TranslationQuote } from "@/lib/core/metering";
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

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

class RequestBodyLimitError extends Error {}

/** Read a request stream with a hard cap even when Content-Length is absent or false. */
async function readBoundedBody(req: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new RequestBodyLimitError("request body exceeds upload limit");
  }
  if (!req.body) throw new Error("missing request body");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel("upload limit exceeded");
      throw new RequestBodyLimitError("request body exceeds upload limit");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Keep compatibility with older multipart clients without trusting their framing. */
async function readBoundedFormData(req: Request, maxFileBytes: number): Promise<FormData> {
  const body = await readBoundedBody(req, maxFileBytes + MULTIPART_OVERHEAD_BYTES);
  const boundedRequest = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: Uint8Array.from(body).buffer,
  });
  return boundedRequest.formData();
}

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  let bytes: Uint8Array;
  try {
    const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === "application/epub+zip") {
      bytes = await readBoundedBody(req, config.maxEpubUploadBytes);
      if (bytes.byteLength === 0) throw new Error("empty EPUB");
    } else {
      const form = await readBoundedFormData(req, config.maxEpubUploadBytes);
      const file = form.get("epub");
      if (!(file instanceof File)) {
        return Response.json({ error: "Hiányzik az EPUB fájl." }, { status: 400 });
      }
      if (file.size > config.maxEpubUploadBytes) {
        return Response.json({ error: "Az EPUB fájl túl nagy." }, { status: 413 });
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    }
  } catch (err) {
    const tooLarge = err instanceof RequestBodyLimitError;
    return Response.json(
      { error: tooLarge ? "Az EPUB fájl túl nagy." : "Érvénytelen feltöltési kérés." },
      { status: tooLarge ? 413 : 400 },
    );
  }
  let title: string | undefined;
  let spineItemCount: number;
  let quote: TranslationQuote;
  try {
    const epub = parseEpub(bytes, {
      maxArchiveBytes: config.maxEpubUploadBytes,
      maxEntries: config.maxEpubEntries,
      maxUncompressedBytes: config.maxEpubUncompressedBytes,
    });
    title = epub.title;
    spineItemCount = epub.spine.length;
    quote = quoteForEpub(epub);
  } catch (err) {
    // T18 failure bucket: import-broken cohorts must be visible as a
    // denominator, not masquerade as a conversion failure.
    appendEvent(config, {
      type: "import-failed",
      userId: ctx.userId,
      detail: (err as Error).message.slice(0, 120),
    });
    return Response.json(
      { error: `Érvénytelen EPUB: ${(err as Error).message}` },
      { status: err instanceof EpubArchiveLimitError ? 413 : 400 },
    );
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
      sourceHash,
      quote,
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
    sourceCharacters: quote.sourceCharacters,
    requiredCredits: quote.requiredCredits,
    quoteVersion: quote.version,
    words: 0,
    spineItemCount,
    chunks: { total: 0, done: 0 },
    cost: createCostState(config.costCeilingUsd, config.model),
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
    sourceHash,
    quote,
  });
}
