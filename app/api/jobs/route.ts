import { loadConfig } from "@/lib/server/config";
import { listJobs } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = loadConfig();
  return Response.json({ jobs: listJobs(config) });
}
