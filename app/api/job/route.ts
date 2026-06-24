import { loadConfig } from "@/lib/server/config";
import { deleteJob, isValidJobId } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request): Promise<Response> {
  const config = loadConfig();
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (!id || !isValidJobId(id)) {
    return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });
  }

  const withLibrary = params.get("withLibrary") === "1";
  deleteJob(config, id, withLibrary);
  return Response.json({ ok: true });
}
