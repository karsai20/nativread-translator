import { listLibrary } from "@/lib/core/library";
import { loadConfig } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = loadConfig();
  return Response.json({ books: listLibrary(config.libraryDir) });
}
