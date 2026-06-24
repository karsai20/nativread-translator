import { loadConfig } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only view of the active server configuration (no secrets).
export async function GET(): Promise<Response> {
  const config = loadConfig();
  return Response.json({
    provider: config.providerName,
    costCeilingUsd: config.costCeilingUsd,
    refine: config.refine,
  });
}
