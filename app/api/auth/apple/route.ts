import { loadConfig } from "@/lib/server/config";
import { oidcProvidersFromConfig, verifyIdToken } from "@/lib/server/oidc";
import { bearerToken } from "@/lib/server/request-context";
import { createSessionToken, SESSION_TTL_SECONDS } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const appleProviders = oidcProvidersFromConfig(config).filter(
    (provider) => provider.name === "apple",
  );
  const identityToken = bearerToken(req);
  if (!identityToken || appleProviders.length === 0) {
    return Response.json(
      { error: "Sign in with Apple is not configured." },
      { status: 401 },
    );
  }
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    return Response.json(
      { error: "Session authentication is not configured." },
      { status: 503 },
    );
  }

  const identity = await verifyIdToken(identityToken, appleProviders);
  if (!identity) {
    return Response.json(
      { error: "Invalid Apple identity token." },
      { status: 401 },
    );
  }

  const token = await createSessionToken(identity.userId, config.sessionSecret);
  return Response.json(
    { token, expiresIn: SESSION_TTL_SECONDS },
    { headers: { "cache-control": "private, no-store, max-age=0" } },
  );
}
