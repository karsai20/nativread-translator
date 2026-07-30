import { existsSync } from "node:fs";
import { join } from "node:path";

import { getLibraryEntry } from "@/lib/core/library";
import { loadConfig } from "@/lib/server/config";
import { deleteJob, getState, isValidJobId, ownsJob } from "@/lib/server/jobs";
import { requestContext } from "@/lib/server/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (!id || !isValidJobId(id)) {
    return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });
  }

  // Own job only. Unknown and not-owned both return 404 so existence never leaks.
  if (!ownsJob(getState(config, id), ctx.userId)) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  const withLibrary = params.get("withLibrary") === "1";
  // The library copy is a separately-stored entry. Fail-closed: drop it only on
  // POSITIVE proof of ownership. A present-but-unverifiable dir (meta.json
  // missing/corrupt) is refused rather than blindly removed, so a caller can
  // never delete a library dir they can't be shown to own.
  if (withLibrary) {
    const libEntry = getLibraryEntry(config.libraryDir, id);
    if (libEntry) {
      if (libEntry.userId !== ctx.userId) {
        return Response.json({ error: "Ismeretlen job." }, { status: 404 });
      }
    } else if (existsSync(join(config.libraryDir, id))) {
      return Response.json({ error: "Ismeretlen job." }, { status: 404 });
    }
    // No library dir at all → nothing to drop; deleteJob's rmSync is a no-op.
  }

  deleteJob(config, id, withLibrary);
  return Response.json({ ok: true });
}
