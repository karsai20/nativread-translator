import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "@/lib/server/config";
import { jobDirFor, pauseJob, getState, isValidJobId, ownsJob } from "@/lib/server/jobs";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id || !isValidJobId(id)) return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });
  if (!ownsJob(getState(config, id), ctx.userId)) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }
  if (!existsSync(join(jobDirFor(config, id), "source.epub"))) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  const state = pauseJob(config, id);
  return Response.json({ ok: true, state });
}
