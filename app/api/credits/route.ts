import { CREDIT_PRODUCTS, creditAccount } from "@/lib/server/credits";
import { loadConfig } from "@/lib/server/config";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  return Response.json({
    account: creditAccount(config, ctx.userId),
    products: CREDIT_PRODUCTS,
  });
}
