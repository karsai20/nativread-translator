import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "@/lib/server/config";
import { jobDirFor, cancelJob, isValidJobId } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id || !isValidJobId(id)) return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });
  if (!existsSync(join(jobDirFor(config, id), "source.epub"))) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  const state = cancelJob(config, id);
  return Response.json({ ok: true, state });
}
