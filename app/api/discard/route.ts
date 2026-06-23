import { loadConfig } from "@/lib/server/config";
import { discardJob, isValidJobId } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discard a job: stop it if running, then delete its on-disk directory.
export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!isValidJobId(id)) return Response.json({ error: "Érvénytelen job azonosító." }, { status: 400 });

  discardJob(config, id);
  return Response.json({ ok: true });
}
