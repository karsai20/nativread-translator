import { loadConfig } from "@/lib/server/config";
import { listJobs, ownsJob } from "@/lib/server/jobs";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  // Only the caller's own jobs — never another user's.
  return Response.json({ jobs: listJobs(config).filter((s) => ownsJob(s, ctx.userId)) });
}
