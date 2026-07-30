import type { ServerConfig } from "./config";
import { oidcProvidersFromConfig, verifyIdToken, type OidcProvider } from "./oidc";
import { verifySessionToken } from "./session";

export interface RequestContext {
  userId: string;
}

const USER_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

export function bearerToken(req: Request): string | undefined {
  const auth = req.headers.get("authorization")?.trim();
  if (!auth?.toLowerCase().startsWith("bearer ")) return undefined;
  return auth.slice("bearer ".length).trim();
}

type RequestContextConfig = Pick<
  ServerConfig,
  "mobileSharedSecret" | "appleClientIds" | "googleClientIds" | "sessionSecret" | "allowDevAuth"
>;

/**
 * Resolves the caller's `userId`, or returns a 4xx `Response` to short-circuit.
 *
 * Two modes, chosen by whether Apple/Google login is configured:
 *
 * - **Public mode** (any client id configured): the bearer must be a valid
 *   Apple/Google OIDC id-token. `userId` is derived from the verified token, so
 *   a client can never claim another user's id via a header. This is the Phase
 *   1a trust boundary — once login is configured the header path is gone.
 * - **Dev / LAN mode** (no client id configured): an optional shared secret
 *   plus a trusted `x-nativread-user-id` header. Preserves the homelab and
 *   fake-provider dev flow; never reachable once real login is on. With no
 *   shared secret either, this path serves anyone, so a production build
 *   refuses it unless `ALLOW_DEV_AUTH=1` opts in (`config.allowDevAuth`).
 *
 * `deps.oidcProviders` is injectable so tests supply a local JWKS instead of
 * hitting Apple/Google over the network.
 */
export async function requestContext(
  req: Request,
  config: RequestContextConfig,
  deps: { oidcProviders?: OidcProvider[] } = {},
): Promise<RequestContext | Response> {
  const oidcProviders = deps.oidcProviders ?? oidcProvidersFromConfig(config);

  if (oidcProviders.length > 0) {
    const token = bearerToken(req);
    if (!token) return Response.json({ error: "Unauthorized." }, { status: 401 });
    if (config.sessionSecret) {
      const sessionUserId = await verifySessionToken(token, config.sessionSecret);
      if (sessionUserId) return { userId: sessionUserId };
    }
    const identity = await verifyIdToken(token, oidcProviders);
    if (!identity) return Response.json({ error: "Unauthorized." }, { status: 401 });
    return { userId: identity.userId };
  }

  if (config.mobileSharedSecret) {
    const token = bearerToken(req) ?? req.headers.get("x-nativread-api-key")?.trim();
    if (token !== config.mobileSharedSecret) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
  } else if (!config.allowDevAuth) {
    // No login, no shared secret, and this is a production build: the only
    // remaining path would trust a client-supplied user id. Refuse rather than
    // serve every route unauthenticated because an env var was forgotten.
    return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const raw = req.headers.get("x-nativread-user-id")?.trim() || "local";
  if (!USER_ID_RE.test(raw)) {
    return Response.json({ error: "Invalid user identifier." }, { status: 400 });
  }
  return { userId: raw };
}
