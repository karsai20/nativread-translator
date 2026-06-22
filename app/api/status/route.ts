import { loadConfig } from "@/lib/server/config";
import { getState } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const config = loadConfig();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Hiányzik a job azonosító." }, { status: 400 });

  const state = getState(config, id);
  if (!state) return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  return Response.json(state);
}
