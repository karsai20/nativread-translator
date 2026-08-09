import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import {
  finalizeAIBudget,
  internalJobById,
  internalReleaseAIBudget,
  settleSuccess,
} from "./database";
import { translatorContainer } from "./container";
import { resultKey, safeError } from "./security";
import type {
  ContainerResultMetadata,
  Env,
  TranslationWorkflowParams,
} from "./types";

type TranslationOutcome =
  | { ok: true; metadata: ContainerResultMetadata; resultKey: string }
  | { ok: false; errorCode: string };

/**
 * The runner's result header. Its numbers are bound straight into D1 and into
 * the AI-budget ledger, so the shape is validated here rather than trusted —
 * a malformed header must fail the job, never write NaN into the ledger.
 */
/**
 * Hands a finished job's container slot back to the pool.
 *
 * Never throws: the translation's outcome is already decided by the time this
 * runs, and failing to reclaim a slot must not turn a delivered book into an
 * error. A container that is already gone is the success case anyway.
 */
async function releaseContainer(env: Env, jobId: string): Promise<void> {
  try {
    await translatorContainer(env, jobId).destroy();
  } catch (error) {
    console.warn(JSON.stringify({
      event: "container-release-failed", jobId, error: safeError(error),
    }));
  }
}

function decodeMetadata(value: string | null): ContainerResultMetadata | null {
  if (!value || value.length > 8_192) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded)) as Record<string, unknown>;
    const finite = (key: string) => Number.isFinite(decoded[key]) && (decoded[key] as number) >= 0;
    if (
      !decoded
      || typeof decoded !== "object"
      || (decoded.status !== "done" && decoded.status !== "error" && decoded.status !== "cancelled")
      || !finite("totalChunks")
      || !finite("translatedChunks")
      || !finite("costUsd")
      || (decoded.title !== undefined && typeof decoded.title !== "string")
    ) {
      return null;
    }
    return decoded as unknown as ContainerResultMetadata;
  } catch {
    return null;
  }
}

export class TranslationWorkflow extends WorkflowEntrypoint<Env, TranslationWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<TranslationWorkflowParams>>, step: WorkflowStep): Promise<void> {
    const jobId = event.payload.jobId;
    const prepared = await step.do("validate queued job", async () => {
      const job = await internalJobById(this.env.DB, jobId);
      if (!job || (job.status !== "starting" && job.status !== "queued")) return null;
      if (!(await this.env.ARTIFACTS.head(job.source_key))) return null;
      const now = new Date().toISOString();
      const changed = await this.env.DB.prepare(
        "UPDATE jobs SET status = 'running', workflow_instance_id = ?, updated_at = ?, " +
        "error_code = NULL, error_message = NULL WHERE id = ? AND status IN ('starting', 'queued')",
      ).bind(event.instanceId, now, jobId).run();
      if ((changed.meta.changes ?? 0) !== 1) return null;
      return {
        sourceKey: job.source_key,
        sourceHash: job.source_hash,
        resultKey: resultKey(job.user_id, job.id),
        sample: job.sample === 1,
        sourceLanguage: job.source_language,
        targetLanguage: job.target_language,
      };
    });
    if (!prepared) return;

    let outcome: TranslationOutcome;
    try {
      outcome = await step.do(
        "translate epub once",
        {
          // Provider calls cost money. Transport-level automatic replays could
          // charge twice, so the translation step itself is never retried.
          retries: { limit: 0, delay: "1 second" },
          // Bound a stuck provider/container call. Workflows guidance caps
          // step timeouts at 30 minutes; a timeout fails closed and refunds
          // reserved credits in the failure step below.
          timeout: "30 minutes",
          sensitive: "output",
        },
        async () => {
          const source = await this.env.ARTIFACTS.get(prepared.sourceKey);
          if (!source?.body) return { ok: false, errorCode: "source_missing" } as const;

          // The containers runtime refuses a body whose length it cannot know,
          // and an R2 stream carries none — every translation died here with
          // "Provided readable stream must have a known length" before it ever
          // reached the container. FixedLengthStream declares the size up
          // front, so the book still streams through instead of being buffered
          // whole in the isolate. The runner also reads `content-length` to
          // enforce its own archive limit, so the header has to agree with it.
          const sized = new FixedLengthStream(source.size);
          // The pipe outlives none of the branches below: a FixedLengthStream
          // that nobody drains leaves a promise the runtime can never settle,
          // and workerd then kills the whole workflow invocation with "your
          // Worker's code had hung and would never generate a response" —
          // after the book was already translated and published. Aborting in
          // `finally` settles it on every path; on the happy path the pipe is
          // long finished and the abort is a no-op.
          const pump = new AbortController();
          const pumped = source.body.pipeTo(sized.writable, { signal: pump.signal })
            .catch((error: unknown) => {
              if (pump.signal.aborted) return;
              console.error(JSON.stringify({
                event: "source-stream-failed", jobId, error: safeError(error),
              }));
            });

          try {
            const container = translatorContainer(this.env, jobId);
            const response = await container.fetch("http://container/run", {
              method: "POST",
              headers: {
                "content-type": "application/epub+zip",
                "content-length": String(source.size),
                "x-nativread-internal-token": this.env.CONTAINER_INTERNAL_TOKEN,
                "x-nativread-job-id": jobId,
                "x-nativread-source-hash": prepared.sourceHash,
                "x-nativread-sample": prepared.sample ? "1" : "0",
                "x-nativread-source-lang": prepared.sourceLanguage,
                "x-nativread-target-lang": prepared.targetLanguage,
              },
              body: sized.readable,
            });

            if (!response.ok || !response.body) {
              await response.body?.cancel().catch(() => undefined);
              return {
                ok: false,
                errorCode: response.status === 422 ? "translation_refused" : "runner_failed",
              } as const;
            }
            const metadata = decodeMetadata(response.headers.get("x-nativread-result"));
            if (!metadata || metadata.status !== "done") {
              await response.body.cancel("invalid result metadata");
              return { ok: false, errorCode: "invalid_runner_result" } as const;
            }

            // Account deletion can race a long translation. Check before and
            // after the put; if the job disappeared, discard any orphan object.
            const current = await internalJobById(this.env.DB, jobId);
            if (!current || current.status !== "running") {
              await response.body.cancel("job no longer active");
              return { ok: false, errorCode: "job_cancelled" } as const;
            }
            // R2 refuses a stream whose length it cannot know, and the runner's
            // `content-length` does not survive the container proxy — the same
            // TypeError that killed the request leg then killed the result leg,
            // after the whole book had already been paid for and translated.
            // Buffering gives R2 an exact length and consumes the body, so a
            // failed put cannot leave a dangling stream to hang the step.
            // ponytail: holds the translated EPUB in memory; the isolate's 128 MB
            // is comfortable against a 32 MB upload ceiling. Switch to a
            // FixedLengthStream if the runner ever reports the output size.
            const translated = await response.arrayBuffer();
            await this.env.ARTIFACTS.put(prepared.resultKey, translated, {
              httpMetadata: { contentType: "application/epub+zip" },
              customMetadata: { jobId, sourceHash: prepared.sourceHash },
            });
            return { ok: true, metadata, resultKey: prepared.resultKey } as const;
          } finally {
            pump.abort();
            await pumped;
          }
        },
      );
    } catch (error) {
      console.error(JSON.stringify({ event: "workflow-translation-error", jobId, error: safeError(error) }));
      outcome = { ok: false, errorCode: "translation_infrastructure_error" };
    }

    // The job is over either way, so its container has to give the slot back
    // now rather than idle until `sleepAfter`. With `max_instances: 6` a
    // handful of finished translations was enough to leave an upload with no
    // container to be inspected in, which reads as "the upload is stuck".
    await releaseContainer(this.env, jobId);

    if (!outcome.ok) {
      await step.do("record failed translation", async () => {
        const now = new Date().toISOString();
        await this.env.DB.prepare(
          "UPDATE jobs SET status = 'error', error_code = ?, error_message = ?, " +
          "updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        ).bind(
          outcome.errorCode,
          "A fordítás nem sikerült. Próbáld újra később.",
          now,
          now,
          jobId,
        ).run();
        await internalReleaseAIBudget(this.env.DB, jobId);
      });
      return;
    }

    await step.do("publish translated epub", async () => {
      const now = new Date().toISOString();
      const changed = await this.env.DB.prepare(
        "UPDATE jobs SET status = 'done', result_key = ?, title = COALESCE(?, title), " +
        "translated_chunks = ?, total_chunks = ?, cost_usd = ?, updated_at = ?, finished_at = ? " +
        "WHERE id = ? AND status = 'running'",
      ).bind(
        outcome.resultKey,
        outcome.metadata.title?.slice(0, 500) ?? null,
        outcome.metadata.translatedChunks,
        outcome.metadata.totalChunks,
        Math.max(0, outcome.metadata.costUsd),
        now,
        now,
        jobId,
      ).run();
      let job = await internalJobById(this.env.DB, jobId);
      if ((changed.meta.changes ?? 0) !== 1) {
        // A step can be replayed after its first D1 update committed but a
        // later binding call failed. Treat our already-published result as
        // success instead of deleting it on replay.
        if (job?.status === "done" && job.result_key === outcome.resultKey) {
          await finalizeAIBudget(this.env.DB, jobId, outcome.metadata.costUsd);
          await settleSuccess(this.env.DB, job);
          return;
        }
        await this.env.ARTIFACTS.delete(outcome.resultKey);
          await internalReleaseAIBudget(this.env.DB, jobId);
        return;
      }
      job = await internalJobById(this.env.DB, jobId);
      if (job) {
        await finalizeAIBudget(this.env.DB, jobId, outcome.metadata.costUsd);
        await settleSuccess(this.env.DB, job);
      }
    });
  }
}
