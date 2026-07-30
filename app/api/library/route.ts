import { listLibrary } from "@/lib/core/library";
import { loadConfig } from "@/lib/server/config";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  // Scope the library to the caller (listLibrary filters by userId).
  return Response.json({ books: listLibrary(config.libraryDir, ctx.userId) });
}
