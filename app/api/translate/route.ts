import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "@/lib/server/config";
import { jobDirFor, startJob, isValidJobId } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const { id, sample } = (await req.json().catch(() => ({}))) as { id?: string; sample?: boolean };
  if (!id || !isValidJobId(id)) return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });

  const jobDir = jobDirFor(config, id);
  if (!existsSync(join(jobDir, "source.epub"))) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  startJob(config, id, { sample: Boolean(sample) });
  return Response.json({ ok: true });
}
