import { loadConfig } from "@/lib/server/config";
import { listJobs } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Active (not-yet-finished) translation jobs for the main-page admin panel.
export async function GET(): Promise<Response> {
  const config = loadConfig();
  return Response.json({ jobs: listJobs(config) });
}
