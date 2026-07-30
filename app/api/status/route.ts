import { loadConfig } from "@/lib/server/config";
import { getState, isValidJobId, ownsJob } from "@/lib/server/jobs";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !isValidJobId(id)) return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });

  const state = getState(config, id);
  // Unknown and not-owned both 404 (fail-closed, no existence leak).
  if (!ownsJob(state, ctx.userId)) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }
  return Response.json(state);
}
