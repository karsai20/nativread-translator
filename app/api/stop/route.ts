import { loadConfig } from "@/lib/server/config";
import { isValidJobId, stopJob } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stop a running job (resumable): aborts the in-flight request; finished chunks are kept.
export async function POST(req: Request): Promise<Response> {
  loadConfig();
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!isValidJobId(id)) return Response.json({ error: "Érvénytelen job azonosító." }, { status: 400 });

  const stopped = stopJob(id);
  return Response.json({ ok: true, stopped });
}
