import { loadConfig } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only view of the active server configuration (no secrets).
export async function GET(): Promise<Response> {
  const config = loadConfig();
  return Response.json({
    provider: config.providerName,
    model: config.model,
    apiConfigured: Boolean(config.apiKey),
    costCeilingUsd: config.costCeilingUsd,
    refine: config.refine,
    refineSelective: config.refineSelective,
    reasonerForHard: config.reasonerForHard,
    reasonerModel: config.reasonerModel,
    precision: config.precision,
    concurrency: config.concurrency,
    recommendedProvider: "gemini",
    recommendedModel: "gemini-2.5-flash",
    appProfile: process.env.APP_PROFILE?.trim() || "web",
  });
}
