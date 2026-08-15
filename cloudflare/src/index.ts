import { revokeAppleAuthorizationCode } from "../../lib/server/apple-oauth";

import { INSPECT_CONTAINER, TranslatorContainer, translatorContainer } from "./container";
import type { BookPurchaseInput } from "./database";
import {
  UserDataRepository,
  bookTierFor,
  internalJobById,
  internalReleaseAIBudget,
  pricingPayload,
} from "./database";
import {
  honouredVersions,
  termsReleaseFor,
  validateTermsAcceptance,
} from "./legal";
import {
  HttpError,
  appAccountTokenFor,
  bearerToken,
  enforceRateLimit,
  ensureAccount,
  errorResponse,
  hmacSubject,
  identityFromAppleToken,
  json,
  mintSession,
  objectPrefix,
  parseSmallJson,
  recordSecurityEvent,
  requestId,
  requireUser,
  safeError,
  securityHeaders,
  sessionSecret,
  sha256,
  sourceKey,
} from "./security";
import { appStoreTransaction, transactionRejection } from "./storekit";
import type { Env, JobRow, TranslationMessage } from "./types";
import { TranslationWorkflow } from "./workflow";
import {
  DEFAULT_PAIR,
  isLanguageCode,
  isValidatedPair,
  languageName,
  validatedPairs,
  type LanguagePair,
} from "../../lib/core/languages";

export { TranslationWorkflow, TranslatorContainer };
// Required by the containers runtime whenever a container intercepts outbound
// traffic — and TranslatorContainer does, via `interceptHttps`/`allowedHosts`.
// Without this export every container start fails with
// "ctx.exports.ContainerProxy is undefined".
export { ContainerProxy } from "@cloudflare/containers";

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function integerEnv(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function moneyEnvCents(value: string, fallbackUsd: number, minUsd: number, maxUsd: number): number {
  const parsed = Number(value);
  const usd = Number.isFinite(parsed) && parsed >= minUsd && parsed <= maxUsd
    ? parsed
    : fallbackUsd;
  return Math.ceil(usd * 100);
}

function retentionExpiry(env: Env): string {
  const hours = integerEnv(env.ARTIFACT_RETENTION_HOURS, 24, 1, 30 * 24);
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : null;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : Uint8Array.from(bytes).buffer;
}

async function readBoundedBody(request: Request, maximumBodyBytes: number): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBodyBytes) {
    throw new HttpError(413, "Az EPUB fájl túl nagy.");
  }
  if (!request.body) throw new HttpError(400, "Hiányzik a feltöltés.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBodyBytes) {
      await reader.cancel("upload limit exceeded");
      throw new HttpError(413, "Az EPUB fájl túl nagy.");
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

async function readBoundedFormData(request: Request, maximumFileBytes: number): Promise<FormData> {
  const body = await readBoundedBody(request, maximumFileBytes + MULTIPART_OVERHEAD_BYTES);
  try {
    return await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: exactArrayBuffer(body),
    }).formData();
  } catch {
    throw new HttpError(400, "Érvénytelen feltöltési kérés.");
  }
}

/** The container names the exact reason a book was rejected; surface it to the reader. */
async function rejectionReason(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const reason = typeof body?.error === "string" ? body.error.trim().slice(0, 160) : "";
  return reason ? ` (${reason})` : "";
}

async function inspectUpload(
  env: Env,
  jobId: string,
  bytes: Uint8Array,
): Promise<{
  sourceHash: string;
  title?: string;
  spineItemCount: number;
  quote: { version: string; sourceCharacters: number; requiredCredits: number; charactersPerCredit: number };
}> {
  // Inspection is a sub-second stateless parse. Naming the container after the
  // job gave every upload its own instance, which then idled until `sleepAfter`
  // and ate the whole `max_instances` budget — the next upload got no container
  // at all. One shared instance serves every inspection.
  // ponytail: single instance; shard to `inspect-<n>` if parse throughput bites.
  const container = translatorContainer(env, INSPECT_CONTAINER);
  let response: Response;
  try {
    response = await container.fetch("http://container/inspect", {
      method: "POST",
      headers: {
        "content-type": "application/epub+zip",
        "content-length": String(bytes.byteLength),
        "x-nativread-internal-token": env.CONTAINER_INTERNAL_TOKEN,
        "x-nativread-job-id": jobId,
      },
      body: exactArrayBuffer(bytes),
    });
  } catch {
    // No container to run the check in. That is our capacity, not a bad book.
    throw new HttpError(503, "A szolgáltatás pillanatnyilag túlterhelt. Próbáld újra egy perc múlva.");
  }
  if (!response.ok) {
    if (response.status === 413) {
      // Four unrelated limits arrive here — compressed size, entry count,
      // uncompressed size, and ZIP64/multi-disk, which is a capability gap and
      // not a size at all. Calling all four "the file is too large" sent a
      // reader looking at an average-sized book for a problem that was not
      // there, and threw away the one line that said what actually happened.
      const reason = await rejectionReason(response);
      console.error(JSON.stringify({ event: "epub-rejected", jobId, reason }));
      throw new HttpError(413, `Ezt az EPUB-ot nem tudjuk feldolgozni.${reason}`);
    }
    // Allowlist, not denylist: only 400 and 413 are verdicts on the book. Any
    // other status (auth, boot, crash) is our side and must not read as
    // "your file is broken" — that is what hid this outage for a whole morning.
    if (response.status !== 400) {
      // The reader gets a generic message, so the status has to reach the log
      // or the outage is invisible from the outside.
      console.error(JSON.stringify({
        event: "inspect-unavailable",
        status: response.status,
        detail: (await response.text().catch(() => "")).slice(0, 200),
      }));
      throw new HttpError(502, "A könyv ellenőrzése nem sikerült.");
    }
    throw new HttpError(400, `Érvénytelen EPUB fájl.${await rejectionReason(response)}`);
  }
  const body = await response.json() as {
    sourceHash?: unknown;
    title?: unknown;
    spineItemCount?: unknown;
    quote?: Record<string, unknown>;
  };
  if (
    typeof body.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(body.sourceHash)
    || !Number.isSafeInteger(body.spineItemCount)
    || !body.quote
    || typeof body.quote.version !== "string"
    || !Number.isSafeInteger(body.quote.sourceCharacters)
    || !Number.isSafeInteger(body.quote.requiredCredits)
    || !Number.isSafeInteger(body.quote.charactersPerCredit)
  ) {
    throw new HttpError(502, "A könyv ellenőrzése nem sikerült.");
  }
  return {
    sourceHash: body.sourceHash,
    ...(cleanTitle(body.title) ? { title: cleanTitle(body.title)! } : {}),
    spineItemCount: body.spineItemCount as number,
    quote: {
      version: body.quote.version,
      sourceCharacters: body.quote.sourceCharacters as number,
      requiredCredits: body.quote.requiredCredits as number,
      charactersPerCredit: body.quote.charactersPerCredit as number,
    },
  };
}

async function authApple(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Hiányzik az Apple-azonosító.");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const subject = await hmacSubject(sessionSecret(env), `auth:${ip}`);
  await enforceRateLimit(env.DB, subject, "auth-hour", 20, 60 * 60);
  const identity = await identityFromAppleToken(token, env);
  await ensureAccount(env.DB, identity.userId);
  return json({
    ...await mintSession(identity.userId, env),
    // The app must attach this to every StoreKit purchase, so the receipt Apple
    // signs already names the account it belongs to.
    appAccountToken: appAccountTokenFor(identity.userId),
  });
}

async function upload(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  const userData = new UserDataRepository(env.DB, userId);
  await enforceRateLimit(env.DB, userId, "upload-hour", 12, 60 * 60);
  const maximum = integerEnv(env.MAX_EPUB_UPLOAD_BYTES, 32 * 1024 * 1024, 1024, 64 * 1024 * 1024);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  let bytes: Uint8Array;
  if (mediaType === "application/epub+zip") {
    bytes = await readBoundedBody(request, maximum);
  } else {
    const form = await readBoundedFormData(request, maximum);
    const file = form.get("epub");
    if (!(file instanceof File)) throw new HttpError(400, "Hiányzik az EPUB fájl.");
    if (file.size > maximum) throw new HttpError(413, "Az EPUB fájl túl nagy.");
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  if (bytes.byteLength === 0) throw new HttpError(400, "Az EPUB fájl üres.");
  const jobId = crypto.randomUUID();
  const key = sourceKey(userId, jobId);

  await env.ARTIFACTS.put(key, bytes, {
    httpMetadata: { contentType: "application/epub+zip" },
    customMetadata: { jobId },
  });
  try {
    const inspected = await inspectUpload(env, jobId, bytes);
    if (inspected.sourceHash !== await sha256(bytes)) {
      throw new HttpError(409, "A feltöltött fájl ellenőrzése nem egyezett.");
    }
    const tier = bookTierFor(inspected.quote.sourceCharacters);
    if (!tier) {
      throw new HttpError(
        413,
        "Ez a könyv hosszabb annál, mint amit egy fordításban vállalunk.",
        "book_too_long",
      );
    }
    const price = {
      productId: tier.productId,
      tier: tier.tier,
      sourceCharacters: inspected.quote.sourceCharacters,
    };
    const entitledLanguages = await userData.entitled(inspected.sourceHash, "hu")
      ? ["hu"]
      : [];
    const existing = await userData.completedTranslation(inspected.sourceHash, "hu");
    if (existing?.result_key && await env.ARTIFACTS.head(existing.result_key)) {
      await env.ARTIFACTS.delete(key);
      return json({
        id: existing.id,
        title: existing.title,
        spineItemCount: inspected.spineItemCount,
        provider: env.PROVIDER_NAME,
        alreadyTranslated: true,
        entitledLanguages,
        sourceHash: inspected.sourceHash,
        quote: inspected.quote,
        price,
      });
    }

    const now = new Date().toISOString();
    await userData.createPendingJob({
      id: jobId,
      sourceKey: key,
      provider: env.PROVIDER_NAME,
      sourceHash: inspected.sourceHash,
      title: inspected.title ?? null,
      spineItemCount: inspected.spineItemCount,
      sourceCharacters: inspected.quote.sourceCharacters,
      requiredCredits: inspected.quote.requiredCredits,
      quoteVersion: inspected.quote.version,
      createdAt: now,
      expiresAt: retentionExpiry(env),
    });
    return json({
      id: jobId,
      title: inspected.title,
      spineItemCount: inspected.spineItemCount,
      provider: env.PROVIDER_NAME,
      entitledLanguages,
      sourceHash: inspected.sourceHash,
      quote: inspected.quote,
      price,
    });
  } catch (error) {
    await env.ARTIFACTS.delete(key).catch(() => undefined);
    throw error;
  }
}

/**
 * Turns a StoreKit transaction into the entitlement for one book.
 *
 * Nothing the device sends is trusted: the transaction id is looked up at Apple,
 * and the receipt has to name this bundle, this account (appAccountToken) and the
 * exact tier the uploaded book falls into. The device only tells us which job it
 * is paying for.
 */
async function purchase(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  const userData = new UserDataRepository(env.DB, userId);
  await enforceRateLimit(env.DB, userId, "purchase-hour", 20, 60 * 60);

  const body = await parseSmallJson<{ id?: unknown; transactionId?: unknown }>(request);
  if (typeof body.id !== "string" || !UUID_PATTERN.test(body.id)) {
    throw new HttpError(400, "Érvénytelen fordításazonosító.");
  }
  if (typeof body.transactionId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(body.transactionId)) {
    throw new HttpError(400, "Érvénytelen tranzakcióazonosító.");
  }

  const job = await userData.job(body.id);
  if (!job) throw new HttpError(404, "Ismeretlen fordítás.");
  const tier = bookTierFor(job.source_characters);
  if (!tier) throw new HttpError(409, "Ez a könyv hosszabb annál, mint amit lefordítunk.");

  const purchased = await verifiedPurchase(body.transactionId, env, userId, tier.productId);
  if (typeof purchased === "string") {
    await recordSecurityEvent(env.DB, userId, "storekit-rejected", `${purchased}:${body.transactionId}`);
    throw new HttpError(409, "Ez a vásárlás nem érvényes ehhez a könyvhöz.");
  }

  const recorded = await userData.recordBookPurchase(job, purchased);
  if (recorded.conflict) {
    await recordSecurityEvent(env.DB, userId, "storekit-replay", `foreign:${body.transactionId}`);
    throw new HttpError(409, "Ez a tranzakció már egy másik vásárláshoz tartozik.");
  }
  return json({ ok: true, applied: recorded.applied, entitledLanguages: ["hu"] });
}

/**
 * Verifies a transaction with Apple, or names the reason it may not be spent.
 *
 * Xcode's local StoreKit test transactions do not exist at Apple, so the purchase
 * UI could not be exercised at all without the bypass below. It is bound to the
 * same dev switch as the dev auth bypass, which production sets to 0.
 */
async function verifiedPurchase(
  transactionId: string,
  env: Env,
  userId: string,
  expectedProductId: string,
): Promise<BookPurchaseInput | string> {
  const isDevBypass = env.ENVIRONMENT !== "production"
    && env.ALLOW_DEV_AUTH === "1"
    && transactionId.startsWith("debug-");
  if (isDevBypass) {
    return { transactionId, productId: expectedProductId, environment: "Sandbox" };
  }

  const transaction = await appStoreTransaction(transactionId, env);
  const rejection = transactionRejection(transaction, {
    bundleId: env.APP_STORE_BUNDLE_ID,
    productId: expectedProductId,
    appAccountToken: appAccountTokenFor(userId),
    requireProduction: env.ENVIRONMENT === "production",
  });
  return rejection ?? {
    transactionId: transaction.transactionId,
    productId: transaction.productId,
    environment: transaction.environment,
  };
}

async function startTranslation(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  const userData = new UserDataRepository(env.DB, userId);
  await enforceRateLimit(env.DB, userId, "translation-day", 8, 24 * 60 * 60);
  const body = await parseSmallJson<{
    id?: unknown;
    sample?: unknown;
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
    rightsAttested?: unknown;
    termsAccepted?: unknown;
    termsVersion?: unknown;
    termsAcceptance?: unknown;
    aiProcessingConsent?: unknown;
    aiConsentVersion?: unknown;
    aiProvider?: unknown;
  }>(request);
  if (typeof body.id !== "string" || !UUID_PATTERN.test(body.id)) {
    throw new HttpError(400, "Érvénytelen fordításazonosító.");
  }
  // The pair is validated here, once, against the registry. `validated` is the
  // release gate: a pair that is wired but unread stays a 400 rather than a
  // best-effort translation at unknown quality.
  const pair: LanguagePair = {
    source: body.sourceLanguage === undefined ? DEFAULT_PAIR.source : body.sourceLanguage as never,
    target: body.targetLanguage === undefined ? DEFAULT_PAIR.target : body.targetLanguage as never,
  };
  if (!isLanguageCode(pair.source) || !isLanguageCode(pair.target)) {
    throw new HttpError(400, "Ismeretlen nyelv.");
  }
  if (!isValidatedPair(pair)) {
    const open = validatedPairs()
      .map((p) => `${languageName(p.source)} → ${languageName(p.target)}`)
      .join(", ");
    throw new HttpError(400, `Ez a nyelvpár még nincs jóváhagyva. Elérhető: ${open}.`);
  }
  // Any still-honoured terms release is accepted, not only the current one:
  // an app build in a user's hands cannot be updated in step with a deploy.
  // The release the client names is what gets recorded, so the evidence stays
  // exact even while two versions are live.
  if (body.rightsAttested !== true || body.termsAccepted !== true) {
    throw new HttpError(403, "A fordítás előtt fogadd el az aktuális felhasználási feltételeket.");
  }
  const termsRelease = termsReleaseFor(body.termsVersion, env);
  if (!termsRelease) {
    // The reader did accept — they accepted a release this deployment no longer
    // honours, which no amount of accepting again can fix. Telling them to
    // accept the terms here is what made this a dead end: the app had just
    // walked them through the checkbox.
    throw new HttpError(
      403,
      "Ez az appverzió elavult felhasználási feltételeket mutat. Frissítsd az appot, és próbáld újra.",
      "terms_version_unsupported",
    );
  }
  const termsAcceptance = validateTermsAcceptance(body.termsAcceptance, env, termsRelease);
  if (
    body.aiProcessingConsent !== true
    || typeof body.aiConsentVersion !== "string"
    || !honouredVersions(env.AI_CONSENT_VERSION, env.AI_CONSENT_SUPERSEDED)
      .includes(body.aiConsentVersion)
    || body.aiProvider !== env.AI_PROVIDER_DISCLOSURE
  ) {
    throw new HttpError(403, "Az AI-feldolgozáshoz új, szolgáltatóspecifikus engedély szükséges.");
  }

  let job = await userData.job(body.id);
  if (!job) throw new HttpError(404, "Ismeretlen fordítás.");
  if (job.status === "done" || ["queued", "starting", "running"].includes(job.status)) {
    return json({ ok: true });
  }
  if (!(await env.ARTIFACTS.head(job.source_key))) {
    throw new HttpError(410, "A feltöltés lejárt. Töltsd fel újra a könyvet.");
  }

  await userData.recordAcceptance(job, termsAcceptance, termsRelease);

  const isSample = body.sample === true;
  const jobBudgetCents = moneyEnvCents(env.COST_CEILING_USD, 3, 0.01, 100);
  const dailyBudgetCents = moneyEnvCents(env.GLOBAL_DAILY_AI_BUDGET_USD, 5, 1, 10_000);
  const monthlyBudgetCents = moneyEnvCents(env.GLOBAL_MONTHLY_AI_BUDGET_USD, 25, 1, 100_000);
  const budgetReservation = await userData.reserveJobBudget(
    job,
    new Date().toISOString().slice(0, 10),
    jobBudgetCents,
    dailyBudgetCents,
    monthlyBudgetCents,
  );
  if (!budgetReservation.ok) {
    throw new HttpError(
      503,
      "A napi AI-költségkeret elfogyott. Próbáld újra holnap.",
      "daily_ai_budget_reached",
    );
  }
  try {
    if (isSample) {
      if (!(await userData.claimJobPreview(job))) {
        throw new HttpError(409, "Ehhez a könyvhöz az ingyenes fejezetet már felhasználtad.");
      }
    } else if (env.REQUIRE_TRANSLATION_ENTITLEMENTS === "1") {
      if (!(await userData.entitled(job.source_hash, "hu"))) {
        if (budgetReservation.acquired) await userData.releaseJobBudget(job.id);
        const tier = bookTierFor(job.source_characters);
        return json(
          {
            error: "Ehhez a könyvhöz még nincs megvásárolt fordítás.",
            code: "purchase_required",
            productId: tier?.productId,
            sourceCharacters: job.source_characters,
          },
          { status: 402 },
        );
      }
    }
  } catch (error) {
    if (budgetReservation.acquired) await userData.releaseJobBudget(job.id);
    throw error;
  }

  const now = new Date().toISOString();
  const changed = await userData.queueJob(
    job.id,
    isSample,
    pair,
    termsRelease.version,
    env.AI_CONSENT_VERSION,
    env.AI_PROVIDER_DISCLOSURE,
    now,
  );
  if (changed !== 1) {
    job = await userData.job(job.id);
    if (job && ["queued", "starting", "running", "done"].includes(job.status)) return json({ ok: true });
    if (budgetReservation.acquired) await userData.releaseJobBudget(job?.id ?? body.id);
    throw new HttpError(409, "A fordítás állapota közben megváltozott.");
  }
  try {
    await env.TRANSLATION_QUEUE.send({ jobId: job.id }, { contentType: "json" });
  } catch (error) {
    await userData.markQueueFailed(
      job.id,
      "A fordítás ütemezése nem sikerült.",
      new Date().toISOString(),
    );
    await userData.releaseJobBudget(job.id);
    throw error;
  }
  return json({ ok: true }, { status: 202 });
}

async function status(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  const userData = new UserDataRepository(env.DB, userId);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Érvénytelen fordításazonosító.");
  const job = await userData.job(id);
  if (!job) throw new HttpError(404, "Ismeretlen fordítás.");
  return json({
    id: job.id,
    status: job.status,
    title: job.title,
    chunks: { total: job.total_chunks, done: job.translated_chunks },
    error: job.error_message,
  });
}

function streamWithCleanup(
  source: ReadableStream<Uint8Array>,
  context: ExecutionContext,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        controller.close();
        context.waitUntil(cleanup());
      } else {
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
      // Interrupted downloads remain available until the retention sweep.
      if (!finished) await reader.cancel(reason);
    },
  });
}

async function result(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const userId = await requireUser(request, env);
  const userData = new UserDataRepository(env.DB, userId);
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Érvénytelen fordításazonosító.");
  const job = await userData.job(id);
  if (!job) throw new HttpError(404, "Ismeretlen fordítás.");
  if (job.status !== "done" || !job.result_key) throw new HttpError(409, "A fordítás még nem tölthető le.");
  const object = await env.ARTIFACTS.get(job.result_key);
  if (!object?.body) throw new HttpError(410, "A fordítás szerverpéldánya már nem érhető el.");
  const consume = url.searchParams.get("consume") === "1";
  const body = consume
    ? streamWithCleanup(object.body, context, async () => {
        await env.ARTIFACTS.delete([job.source_key, job.result_key!]);
        await userData.markResultConsumed(job.id, new Date().toISOString());
      })
    : object.body;
  const headers = securityHeaders({
    "content-type": "application/epub+zip",
    "content-disposition": `attachment; filename="nativread-${job.id}.epub"`,
  });
  return new Response(body, { headers });
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1_000 });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  const userData = new UserDataRepository(env.DB, userId);
  await enforceRateLimit(env.DB, userId, "account-delete-day", 5, 24 * 60 * 60);
  const body = await parseSmallJson<{
    appleIdentityToken?: unknown;
    appleAuthorizationCode?: unknown;
  }>(request);
  if (
    typeof body.appleIdentityToken !== "string"
    || typeof body.appleAuthorizationCode !== "string"
    || body.appleAuthorizationCode.length < 8
    || body.appleAuthorizationCode.length > 4_096
  ) {
    throw new HttpError(400, "Az Apple újbóli hitelesítése szükséges.");
  }
  const freshIdentity = await identityFromAppleToken(body.appleIdentityToken, env);
  if (freshIdentity.userId !== userId) throw new HttpError(403, "A hitelesített Apple-fiók nem egyezik.");
  if (!env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) {
    throw new HttpError(503, "Az Apple-visszavonás nincs beállítva.");
  }
  await revokeAppleAuthorizationCode(body.appleAuthorizationCode, {
    clientId: freshIdentity.audience,
    teamId: env.APPLE_TEAM_ID,
    keyId: env.APPLE_KEY_ID,
    privateKey: env.APPLE_PRIVATE_KEY,
  });

  const jobs = await userData.accountJobs();
  const now = new Date().toISOString();
  await userData.cancelActiveAccountJobs(now);
  for (const job of jobs) {
    await userData.releaseJobBudget(job.id);
    if (job.workflow_instance_id) {
      try {
        await (await env.TRANSLATION_WORKFLOW.get(job.workflow_instance_id)).terminate();
      } catch (error) {
        console.warn(JSON.stringify({ event: "workflow-terminate-failed", jobId: job.id, error: safeError(error) }));
      }
    }
  }
  await deleteR2Prefix(env.ARTIFACTS, objectPrefix(userId));
  await userData.deleteAccount();
  return json({ ok: true });
}

/**
 * What a book costs, before anyone uploads one.
 *
 * The app ships a port of the character counter, so it can name a book's price
 * on device in milliseconds instead of making the reader wait for an upload.
 * That only works while the two agree, which is what this endpoint settles: the
 * app compares `quoteVersion` against its own port and falls back to a server
 * quote whenever they differ, and it reads the tiers from here rather than from
 * a table baked into a shipped binary — so moving a price boundary stays a
 * deploy, not an App Store release.
 *
 * Public and cacheable: product identifiers and their thresholds are not
 * secrets, and the reader needs the price before there is an account to
 * authenticate.
 */
function pricing(): Response {
  const response = json(pricingPayload());
  // Set after `json`, not through it: `securityHeaders` stamps
  // `private, no-store` over whatever it is handed, which is right for every
  // other route here and wrong for this one.
  response.headers.set("cache-control", "public, max-age=3600");
  return response;
}

async function route(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  switch (key) {
    case "GET /health": return json({ ok: true, service: "nativread-api" });
    case "GET /api/pricing": return pricing();
    case "POST /api/auth/apple": return authApple(request, env);
    case "POST /api/upload": return upload(request, env);
    case "POST /api/purchase": return purchase(request, env);
    case "POST /api/translate": return startTranslation(request, env);
    case "GET /api/status": return status(request, env);
    case "GET /api/result": return result(request, env, context);
    case "DELETE /api/account": return deleteAccount(request, env);
    default: throw new HttpError(404, "Nincs ilyen végpont.");
  }
}

async function consumeQueue(batch: MessageBatch<TranslationMessage>, env: Env): Promise<void> {
  const maximum = integerEnv(env.MAX_ACTIVE_TRANSLATIONS, 4, 1, 20);
  for (const message of batch.messages) {
    const job = await internalJobById(env.DB, message.body.jobId);
    if (!job || job.status !== "queued") {
      message.ack();
      continue;
    }
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('starting', 'running')",
    ).first<{ count: number }>();
    if ((active?.count ?? 0) >= maximum) {
      message.retry({ delaySeconds: 60 });
      continue;
    }
    const now = new Date().toISOString();
    const claimed = await env.DB.prepare(
      "UPDATE jobs SET status = 'starting', updated_at = ? WHERE id = ? AND status = 'queued'",
    ).bind(now, job.id).run();
    if ((claimed.meta.changes ?? 0) !== 1) {
      message.ack();
      continue;
    }
    try {
      const instance = await env.TRANSLATION_WORKFLOW.create({
        id: crypto.randomUUID(),
        params: { jobId: job.id },
      });
      await env.DB.prepare(
        "UPDATE jobs SET workflow_instance_id = ?, updated_at = ? WHERE id = ? AND status = 'starting'",
      ).bind(instance.id, new Date().toISOString(), job.id).run();
      message.ack();
    } catch (error) {
      await env.DB.prepare(
        "UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'starting'",
      ).bind(new Date().toISOString(), job.id).run();
      console.error(JSON.stringify({ event: "workflow-create-failed", jobId: job.id, error: safeError(error) }));
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function retentionSweep(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(
    "SELECT * FROM jobs WHERE expires_at <= ? AND (result_key IS NOT NULL OR status IN ('pending', 'queued', 'starting', 'running', 'error')) LIMIT 100",
  ).bind(now).all<JobRow>();
  for (const job of expired.results) {
    await env.ARTIFACTS.delete([job.source_key, ...(job.result_key ? [job.result_key] : [])]);
    await internalReleaseAIBudget(env.DB, job.id);
    await env.DB.prepare(
      "UPDATE jobs SET status = CASE WHEN status = 'done' THEN status ELSE 'cancelled' END, " +
      "result_key = NULL, error_code = CASE WHEN status = 'done' THEN error_code ELSE 'expired' END, " +
      "error_message = CASE WHEN status = 'done' THEN error_message ELSE 'A feltöltés lejárt.' END, " +
      "updated_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?",
    ).bind(now, now, job.id).run();
    if (job.workflow_instance_id) {
      await (await env.TRANSLATION_WORKFLOW.get(job.workflow_instance_id)).terminate().catch(() => undefined);
    }
  }
  // Longer than the longest window any bucket uses (the weekly free-chapter
  // ceiling), or the sweep would hand the allowance back early.
  const rateCutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const eventCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(rateCutoff),
    env.DB.prepare("DELETE FROM security_events WHERE created_at < ?").bind(eventCutoff),
  ]);
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const id = requestId(request);
    try {
      const response = await route(request, env, context);
      response.headers.set("x-request-id", id);
      return response;
    } catch (error) {
      return errorResponse(error, id);
    }
  },
  async queue(batch: MessageBatch<TranslationMessage>, env: Env): Promise<void> {
    await consumeQueue(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(retentionSweep(env));
  },
};
