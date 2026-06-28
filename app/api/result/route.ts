import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "node-html-parser";

import { parseEpub } from "@/lib/core/epub";
import { libraryEpubPath, getLibraryEntry } from "@/lib/core/library";
import { readManifest } from "@/lib/core/job";
import { loadConfig } from "@/lib/server/config";
import { jobDirFor, isValidJobId } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bodyHtml(xhtml: string): string {
  const body = parse(xhtml).querySelector("body");
  return body ? body.innerHTML : xhtml;
}

function titleOf(xhtml: string, index: number): string {
  const h = parse(xhtml).querySelector("h1, h2, title");
  return h?.text?.trim() || `Fejezet ${index + 1}`;
}

export async function GET(req: Request): Promise<Response> {
  const config = loadConfig();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id || !isValidJobId(id)) return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });

  const jobDir = jobDirFor(config, id);
  const jobOut = join(jobDir, "output.epub");
  const libOut = libraryEpubPath(config.libraryDir, id);
  const translatedPath = existsSync(jobOut) ? jobOut : existsSync(libOut) ? libOut : null;
  if (!translatedPath) {
    return Response.json({ error: "A fordítás még nem készült el." }, { status: 409 });
  }

  const translatedBytes = readFileSync(translatedPath);

  if (url.searchParams.get("download") === "1") {
    return new Response(new Uint8Array(translatedBytes), {
      headers: {
        "content-type": "application/epub+zip",
        "content-disposition": `attachment; filename="forditas-${id}.epub"`,
      },
    });
  }

  const translated = parseEpub(new Uint8Array(translatedBytes));

  const sourcePath = join(jobDir, "source.epub");
  const original = existsSync(sourcePath)
    ? parseEpub(new Uint8Array(readFileSync(sourcePath)))
    : undefined;

  const items = translated.spine.map((t, i) => {
    const src = original?.spine.find((s) => s.href === t.href);
    return {
      href: t.href,
      title: titleOf(t.content, i),
      originalHtml: src ? bodyHtml(src.content) : "",
      translatedHtml: bodyHtml(t.content),
    };
  });

  // Surface sample mode so the reader can warn that only the opening was translated
  // (otherwise the mostly-original rest of the book looks like a failed translation).
  // Prefer the job manifest, but fall back to the library entry (the job dir may be gone).
  const sample = Boolean(readManifest(jobDir)?.sample ?? getLibraryEntry(config.libraryDir, id)?.sample);

  return Response.json({ title: translated.title, items, sample });
}
