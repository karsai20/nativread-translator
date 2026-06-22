// EPUB parsing and writing.
//
// An EPUB is a zip with a fixed shape:
//   mimetype                      (stored uncompressed, first entry)
//   META-INF/container.xml        points at the OPF "rootfile"
//   <opf>                         manifest (id -> href) + spine (ordered idrefs)
//   ... XHTML content items, CSS, images
//
// We mirror Quire's container -> OPF -> spine flow so the design transfers to Swift.
// parseEpub gives the ordered spine of XHTML items; writeEpub rebuilds the archive
// with translated XHTML swapped in and everything else copied verbatim.

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const MIMETYPE = "application/epub+zip";
const CONTAINER_PATH = "META-INF/container.xml";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // OPF manifest/spine can be single or array; we normalize below.
});

export interface SpineItem {
  /** manifest item id */
  id: string;
  /** archive path, normalized relative to the archive root */
  href: string;
  mediaType: string;
  /** decoded XHTML text */
  content: string;
}

export interface Epub {
  /** All zip entries by path (raw bytes), so writeEpub can copy non-spine files. */
  entries: Record<string, Uint8Array>;
  opfPath: string;
  /** Ordered XHTML spine items (translation targets). */
  spine: SpineItem[];
}

const XHTML_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
]);

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Resolve an OPF-relative href to a normalized archive path. */
function resolveHref(opfDir: string, href: string): string {
  const raw = opfDir ? `${opfDir}/${href}` : href;
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseEpub(bytes: Uint8Array): Epub {
  const entries = unzipSync(bytes);

  const containerBytes = entries[CONTAINER_PATH];
  if (!containerBytes) throw new Error("Invalid EPUB: missing META-INF/container.xml");

  const container = xml.parse(strFromU8(containerBytes));
  const rootfiles = asArray(container?.container?.rootfiles?.rootfile);
  const opfPath: string | undefined = rootfiles[0]?.["@_full-path"];
  if (!opfPath) throw new Error("Invalid EPUB: container.xml has no rootfile full-path");

  const opfBytes = entries[opfPath];
  if (!opfBytes) throw new Error(`Invalid EPUB: OPF not found at ${opfPath}`);

  const opf = xml.parse(strFromU8(opfBytes));
  const pkg = opf?.package;
  if (!pkg) throw new Error("Invalid EPUB: OPF has no <package>");

  const opfDir = dirname(opfPath);

  // manifest: id -> { href, mediaType }
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const item of asArray(pkg.manifest?.item)) {
    const id = item["@_id"];
    const href = item["@_href"];
    const mediaType = item["@_media-type"] ?? "";
    if (id && href) manifest.set(id, { href, mediaType });
  }

  // spine: ordered idrefs
  const spine: SpineItem[] = [];
  for (const ref of asArray(pkg.spine?.itemref)) {
    const idref = ref["@_idref"];
    if (!idref) continue;
    const m = manifest.get(idref);
    if (!m || !XHTML_TYPES.has(m.mediaType)) continue;

    const path = resolveHref(opfDir, m.href);
    const raw = entries[path];
    if (!raw) continue;

    spine.push({
      id: idref,
      href: path,
      mediaType: m.mediaType,
      content: strFromU8(raw),
    });
  }

  if (spine.length === 0) throw new Error("Invalid EPUB: no XHTML spine items found");

  return { entries, opfPath, spine };
}

/**
 * Rebuild the EPUB with translated XHTML. `translatedByHref` maps a spine item's
 * archive path to its new XHTML string; any path not present is copied unchanged.
 * The `mimetype` entry is written first and stored (level 0) per the EPUB spec.
 */
export function writeEpub(epub: Epub, translatedByHref: Record<string, string>): Uint8Array {
  const out: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};

  // mimetype must be first and stored uncompressed.
  out["mimetype"] = [strToU8(MIMETYPE), { level: 0 }];

  for (const [path, bytes] of Object.entries(epub.entries)) {
    if (path === "mimetype") continue;
    const translated = translatedByHref[path];
    out[path] = translated !== undefined ? strToU8(translated) : bytes;
  }

  // fflate preserves insertion order; mimetype was inserted first.
  return zipSync(out as Record<string, Uint8Array>);
}
