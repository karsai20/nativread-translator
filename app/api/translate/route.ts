import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hashSource } from "@/lib/core/library";
import { readManifest } from "@/lib/core/job";
import { loadConfig } from "@/lib/server/config";
import { jobDirFor, startJob, isValidJobId } from "@/lib/server/jobs";
import { hasTranslationEntitlement } from "@/lib/server/entitlements";
import { requestContext } from "@/lib/server/request-context";
import type { PrecisionMode } from "@/lib/core/quality/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const { id, sample, precision } = (await req.json().catch(() => ({}))) as {
    id?: string;
    sample?: boolean;
    precision?: PrecisionMode;
  };
  if (!id || !isValidJobId(id)) return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });
  if (precision && precision !== "balanced" && precision !== "fidelity" && precision !== "natural") {
    return Response.json({ error: "Érvénytelen minőségi mód." }, { status: 400 });
  }

  const jobDir = jobDirFor(config, id);
  const sourcePath = join(jobDir, "source.epub");
  if (!existsSync(sourcePath)) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  const manifest = readManifest(jobDir);
  if (manifest?.userId && manifest.userId !== ctx.userId) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  if (!sample && config.requireFullTranslationEntitlements) {
    const sourceHash = manifest?.sourceHash ?? hashSource(new Uint8Array(readFileSync(sourcePath)));
    if (!hasTranslationEntitlement(config, ctx.userId, sourceHash)) {
      return Response.json(
        { error: "Full-book translation requires a verified purchase." },
        { status: 402 },
      );
    }
  }

  startJob(config, id, { sample: Boolean(sample), ...(precision ? { precision } : {}) });
  return Response.json({ ok: true });
}
