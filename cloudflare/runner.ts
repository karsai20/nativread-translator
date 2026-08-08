import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { EpubArchiveLimitError, parseEpub } from "../lib/core/epub";
import { runJob, type JobState } from "../lib/core/job";
import { DEFAULT_PAIR, isLanguageCode, type LanguagePair } from "../lib/core/languages";
import { quoteForEpub } from "../lib/core/metering";
import { createProvider, loadConfig } from "../lib/server/config";

const PORT = 8080;
const activeJobs = new Set<string>();

class RunnerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function authorized(request: Request): boolean {
  const expected = process.env.CONTAINER_INTERNAL_TOKEN ?? "";
  const provided = request.headers.get("x-nativread-internal-token") ?? "";
  if (expected.length < 32 || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function boundedInteger(value: string | null | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function archiveLimits() {
  return {
    maxArchiveBytes: boundedInteger(process.env.MAX_EPUB_UPLOAD_BYTES, 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxEntries: boundedInteger(process.env.MAX_EPUB_ENTRIES, 2_000, 1, 10_000),
    maxUncompressedBytes: boundedInteger(
      process.env.MAX_EPUB_UNCOMPRESSED_BYTES,
      128 * 1024 * 1024,
      1024,
      512 * 1024 * 1024,
    ),
  };
}

async function receiveBody(request: Request, destination: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  if (!request.body) throw new RunnerError(400, "Missing EPUB body");
  const maximum = archiveLimits().maxArchiveBytes;
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new RunnerError(413, "EPUB exceeds compressed-size limit");
  }

  const file = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  const reader = request.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("upload limit exceeded");
        throw new RunnerError(413, "EPUB exceeds compressed-size limit");
      }
      hash.update(value);
      await file.write(value);
    }
  } finally {
    await file.close();
  }
  if (total === 0) throw new RunnerError(400, "Empty EPUB body");
  return { bytes: new Uint8Array(await readFile(destination)), sha256: hash.digest("hex") };
}

function validJobId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function metadata(state: JobState) {
  return {
    status: state.status,
    ...(state.title ? { title: state.title } : {}),
    totalChunks: state.chunks.total,
    translatedChunks: state.chunks.done,
    costUsd: state.cost.usd,
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
  };
}

function encodeMetadata(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function inspect(request: Request): Promise<Response> {
  const jobId = request.headers.get("x-nativread-job-id") ?? "";
  if (!validJobId(jobId)) throw new RunnerError(400, "Invalid job id");
  // Flat, not nested under the job: one shared container now serves every
  // inspection, so a per-job parent would pile up empty directories for as
  // long as the instance lives.
  const dir = join("/tmp", "nativread", `inspect-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const received = await receiveBody(request, join(dir, "source.epub"));
    // A rejected book is the caller's problem, not a runner crash: keep the
    // parser's reason and a 4xx so the worker can show it instead of "500".
    let epub;
    try {
      epub = parseEpub(received.bytes, archiveLimits());
    } catch (error) {
      const status = error instanceof EpubArchiveLimitError ? 413 : 400;
      throw new RunnerError(status, (error as Error).message);
    }
    return json({
      sourceHash: received.sha256,
      title: epub.title,
      spineItemCount: epub.spine.length,
      quote: quoteForEpub(epub),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The pair the worker recorded for this job. Unknown codes fall back to the
 * default rather than failing the run: the API already validated the pair, so
 * a mismatch here means a header was lost, not that the user asked for it.
 */
function pairFromHeaders(request: Request): LanguagePair {
  const source = request.headers.get("x-nativread-source-lang");
  const target = request.headers.get("x-nativread-target-lang");
  if (!isLanguageCode(source) || !isLanguageCode(target)) return DEFAULT_PAIR;
  return { source, target };
}

async function translate(request: Request): Promise<Response> {
  const jobId = request.headers.get("x-nativread-job-id") ?? "";
  if (!validJobId(jobId)) throw new RunnerError(400, "Invalid job id");
  if (activeJobs.has(jobId)) throw new RunnerError(409, "Job is already running");
  activeJobs.add(jobId);
  const jobDir = join("/tmp", "nativread", jobId, "run");
  await rm(jobDir, { recursive: true, force: true });
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  try {
    const received = await receiveBody(request, join(jobDir, "source.epub"));
    const expectedHash = request.headers.get("x-nativread-source-hash");
    if (!expectedHash || received.sha256 !== expectedHash) {
      throw new RunnerError(409, "Source hash mismatch");
    }
    const config = loadConfig();
    if (config.providerName !== "gemini") throw new RunnerError(503, "Unsupported production provider");
    const state = await runJob({
      id: jobId,
      pair: pairFromHeaders(request),
      epubBytes: received.bytes,
      provider: createProvider(config),
      jobDir,
      ceilingUsd: config.costCeilingUsd,
      refine: config.refine,
      selectiveRefine: config.refineSelective,
      reasonerForHard: config.reasonerForHard,
      precision: config.precision,
      sample: request.headers.get("x-nativread-sample") === "1",
      concurrency: config.concurrency,
    });
    const summary = metadata(state);
    if (state.status !== "done") return json(summary, 422);
    const output = Bun.file(join(jobDir, "output.epub"));
    if (!(await output.exists())) throw new Error("Translation completed without output");
    return new Response(output, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/epub+zip",
        "content-length": String(output.size),
        "x-nativread-result": encodeMetadata(summary),
        "x-content-type-options": "nosniff",
      },
    });
  } finally {
    activeJobs.delete(jobId);
    // The Response owns an open Bun.file handle; deleting immediately would
    // truncate the stream. Cloudflare stops this per-job container shortly
    // after the request, and /tmp is ephemeral, so lifecycle cleanup owns it.
  }
}

// `authorized` fails closed on a short token, which looks identical to a wrong
// one and never logs. Say it once at boot so the misconfiguration is visible.
if ((process.env.CONTAINER_INTERNAL_TOKEN ?? "").length < 32) {
  console.error(JSON.stringify({
    event: "container-misconfigured",
    error: "CONTAINER_INTERNAL_TOKEN is missing or under 32 chars; every request will 401",
  }));
}

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/ping" && request.method === "GET") return new Response("ok");
      if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (url.pathname === "/inspect") return await inspect(request);
      if (url.pathname === "/run") return await translate(request);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const status = error instanceof RunnerError ? error.status : 500;
      console.error(JSON.stringify({
        event: "container-error",
        status,
        error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : "Unknown error",
      }));
      return json({ error: status >= 500 ? "Translation runner failed" : (error as Error).message }, status);
    }
  },
});
