import { SignJWT, jwtVerify } from "jose";

const SESSION_ISSUER = "nativread-backend";
const SESSION_AUDIENCE = "nativread-ios";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(userId: string, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error("NATIVREAD_SESSION_SECRET must be at least 32 characters.");
  return new SignJWT({ kind: "nativread-session" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key(secret));
}

export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  if (secret.length < 32) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    return payload.kind === "nativread-session" && typeof payload.sub === "string"
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}
