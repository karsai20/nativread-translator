// HTTP API contract (4 routes), wired to the core job engine.
//
//   POST /api/upload    multipart {epub}        -> { id, spineItemCount, provider }
//   POST /api/translate JSON {id}               -> { ok }            (starts/resumes async)
//   GET  /api/status?id=                        -> JobState
//   GET  /api/result?id=[&download=1]           -> reader JSON | EPUB download
//
// Job state lives on disk (resume) via core/job.ts; an in-memory cache mirrors it for
// fast status polling and to track which jobs are actively running.

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "node-html-parser";

import { runJob, readManifest, type JobState } from "../core/job.ts";
import { parseEpub } from "../core/epub.ts";
import { createProvider, type Config } from "./config.ts";

const states = new Map<string, JobState>();
const running = new Set<string>();

function jobDirFor(config: Config, id: string): string {
  return join(config.jobsDir, id);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bodyHtml(xhtml: string): string {
  const body = parse(xhtml).querySelector("body");
  return body ? body.innerHTML : xhtml;
}

function titleOf(xhtml: string, index: number): string {
  const h = parse(xhtml).querySelector("h1, h2, title");
  return h?.text?.trim() || `Fejezet ${index + 1}`;
}

async function handleUpload(req: Request, config: Config): Promise<Response> {
  const form = await req.formData();
  const file = form.get("epub");
  if (!(file instanceof File)) return json({ error: "Hiányzik az EPUB fájl." }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());

  let spineItemCount: number;
  try {
    spineItemCount = parseEpub(bytes).spine.length;
  } catch (err) {
    return json({ error: `Érvénytelen EPUB: ${(err as Error).message}` }, 400);
  }

  const id = crypto.randomUUID();
  const jobDir = jobDirFor(config, id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "source.epub"), bytes);

  const state: JobState = {
    id,
    status: "pending",
    provider: config.providerName,
    spineItemCount,
    chunks: { total: 0, done: 0 },
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, ceilingUsd: config.costCeilingUsd },
  };
  states.set(id, state);

  return json({ id, spineItemCount, provider: config.providerName });
}

async function handleTranslate(req: Request, config: Config): Promise<Response> {
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return json({ error: "Hiányzik a job azonosító." }, 400);

  const jobDir = jobDirFor(config, id);
  const sourcePath = join(jobDir, "source.epub");
  if (!existsSync(sourcePath)) return json({ error: "Ismeretlen job." }, 404);
  if (running.has(id)) return json({ ok: true, alreadyRunning: true });

  const epubBytes = new Uint8Array(readFileSync(sourcePath));
  const provider = createProvider(config);

  running.add(id);
  // Fire-and-forget: progress is observed via /api/status. Errors land in the manifest.
  runJob({
    id,
    epubBytes,
    provider,
    jobDir,
    ceilingUsd: config.costCeilingUsd,
    onProgress: (s) => states.set(id, s),
  })
    .catch((err) => {
      console.error(`[job ${id}] failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => running.delete(id));

  return json({ ok: true });
}

function handleStatus(url: URL, config: Config): Response {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Hiányzik a job azonosító." }, 400);

  const state = states.get(id) ?? readManifest(jobDirFor(config, id));
  if (!state) return json({ error: "Ismeretlen job." }, 404);
  return json(state);
}

function handleResult(url: URL, config: Config): Response {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Hiányzik a job azonosító." }, 400);

  const jobDir = jobDirFor(config, id);
  const outputPath = join(jobDir, "output.epub");
  if (!existsSync(outputPath)) return json({ error: "A fordítás még nem készült el." }, 409);

  if (url.searchParams.get("download") === "1") {
    return new Response(readFileSync(outputPath), {
      headers: {
        "content-type": "application/epub+zip",
        "content-disposition": `attachment; filename="forditas-${id}.epub"`,
      },
    });
  }

  // Bilingual reader payload: original + translated body HTML per spine item.
  const sourcePath = join(jobDir, "source.epub");
  const original = parseEpub(new Uint8Array(readFileSync(sourcePath)));
  const translated = parseEpub(new Uint8Array(readFileSync(outputPath)));

  const items = original.spine.map((src, i) => {
    const dst = translated.spine.find((t) => t.href === src.href) ?? src;
    return {
      href: src.href,
      title: titleOf(src.content, i),
      originalHtml: bodyHtml(src.content),
      translatedHtml: bodyHtml(dst.content),
    };
  });

  return json({ items });
}

/** Route an /api/* request. Returns null for non-API paths (static handles those). */
export async function handleApi(req: Request, config: Config): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/upload" && req.method === "POST") return handleUpload(req, config);
  if (path === "/api/translate" && req.method === "POST") return handleTranslate(req, config);
  if (path === "/api/status" && req.method === "GET") return handleStatus(url, config);
  if (path === "/api/result" && req.method === "GET") return handleResult(url, config);
  if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

  return null;
}
