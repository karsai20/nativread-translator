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

          const container = translatorContainer(this.env, jobId);
          const response = await container.fetch("http://container/run", {
            method: "POST",
            headers: {
              "content-type": "application/epub+zip",
              "x-nativread-internal-token": this.env.CONTAINER_INTERNAL_TOKEN,
              "x-nativread-job-id": jobId,
              "x-nativread-source-hash": prepared.sourceHash,
              "x-nativread-sample": prepared.sample ? "1" : "0",
            },
            body: source.body,
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
          await this.env.ARTIFACTS.put(prepared.resultKey, response.body, {
            httpMetadata: { contentType: "application/epub+zip" },
            customMetadata: { jobId, sourceHash: prepared.sourceHash },
          });
          return { ok: true, metadata, resultKey: prepared.resultKey } as const;
        },
      );
    } catch (error) {
      console.error(JSON.stringify({ event: "workflow-translation-error", jobId, error: safeError(error) }));
      outcome = { ok: false, errorCode: "translation_infrastructure_error" };
    }

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
