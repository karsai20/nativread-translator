import {
  CreditLedgerError,
  grantCreditPurchase,
} from "@/lib/server/credits";
import { loadConfig } from "@/lib/server/config";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const body = (await req.json().catch(() => ({}))) as {
    transactionId?: string;
    productId?: string;
    signedTransactionInfo?: string;
  };
  if (!body.transactionId?.trim() || !body.productId?.trim()) {
    return Response.json({ error: "Missing transaction metadata." }, { status: 400 });
  }
  if (!config.allowUnsignedStoreKitGrants) {
    return Response.json(
      { error: "StoreKit server verification is not configured." },
      { status: 501 },
    );
  }

  try {
    const result = grantCreditPurchase(config, {
      userId: ctx.userId,
      transactionId: body.transactionId.trim(),
      productId: body.productId.trim(),
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CreditLedgerError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
