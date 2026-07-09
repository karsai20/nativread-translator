import {
  ENTITLEMENT_LANGUAGES,
  grantTranslationEntitlement,
  type EntitlementLanguage,
} from "@/lib/server/entitlements";
import { loadConfig } from "@/lib/server/config";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE_HASH_RE = /^[a-f0-9]{64}$/i;

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const body = (await req.json().catch(() => ({}))) as {
    sourceHash?: string;
    targetLanguage?: string;
    transactionId?: string;
    productId?: string;
    signedTransactionInfo?: string;
  };

  if (!body.sourceHash || !SOURCE_HASH_RE.test(body.sourceHash)) {
    return Response.json({ error: "Invalid source hash." }, { status: 400 });
  }
  // Default "hu" keeps pre-multi-language clients working; anything else
  // must be an explicitly supported language.
  const targetLanguage = (body.targetLanguage ?? "hu") as EntitlementLanguage;
  if (!ENTITLEMENT_LANGUAGES.includes(targetLanguage)) {
    return Response.json({ error: "Unsupported target language." }, { status: 400 });
  }
  if (!body.transactionId?.trim() || !body.productId?.trim()) {
    return Response.json({ error: "Missing transaction metadata." }, { status: 400 });
  }

  if (!config.allowUnsignedStoreKitGrants) {
    return Response.json(
      {
        error:
          "StoreKit server verification is not configured. Set up signed transaction verification before enabling paid grants.",
      },
      { status: 501 },
    );
  }

  const entitlement = grantTranslationEntitlement(config, {
    userId: ctx.userId,
    sourceHash: body.sourceHash.toLowerCase(),
    targetLanguage,
    transactionId: body.transactionId.trim(),
    productId: body.productId.trim(),
  });

  return Response.json({ ok: true, entitlement });
}
