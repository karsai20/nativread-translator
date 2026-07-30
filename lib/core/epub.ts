// EPUB parsing and writing.
//
// An EPUB is a zip with a fixed shape:
//   mimetype                      (stored uncompressed, first entry)
//   META-INF/container.xml        points at the OPF "rootfile"
//   <opf>                         manifest (id -> href) + spine (ordered idrefs)
//   ... XHTML content items, CSS, images
//
// We mirror NativRead's container -> OPF -> spine flow so the design transfers to Swift.
// parseEpub gives the ordered spine of XHTML items; writeEpub rebuilds the archive
// with translated XHTML swapped in and everything else copied verbatim.

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const MIMETYPE = "application/epub+zip";
const CONTAINER_PATH = "META-INF/container.xml";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;

export interface EpubArchiveLimits {
  /** Compressed archive bytes accepted by the parser. */
  maxArchiveBytes: number;
  /** Central-directory entries accepted before any decompression. */
  maxEntries: number;
  /** Sum of central-directory uncompressed sizes. */
  maxUncompressedBytes: number;
}

/** Defaults target prose EPUBs while leaving ample room for fonts and images. */
export const DEFAULT_EPUB_ARCHIVE_LIMITS: Readonly<EpubArchiveLimits> = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 2_000,
  maxUncompressedBytes: 128 * 1024 * 1024,
};

export class EpubArchiveLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubArchiveLimitError";
  }
}

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
  /** dc:title from the OPF, if present. */
  title?: string;
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

function unsafeArchivePath(path: string): boolean {
  if (!path || path.includes("\0") || path.startsWith("/") || path.startsWith("\\")) return true;
  if (/^[a-z]:[\\/]/i.test(path)) return true;
  return path.replace(/\\/g, "/").split("/").some((segment) => segment === "..");
}

function findEndOfCentralDirectory(view: DataView): number {
  const start = view.byteLength - ZIP_EOCD_MIN_BYTES;
  const lowerBound = Math.max(0, start - ZIP_MAX_COMMENT_BYTES);
  for (let offset = start; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error("Invalid EPUB: ZIP central directory is missing");
}

/**
 * Read only ZIP metadata and reject dangerous archives before `unzipSync` can
 * allocate their advertised output. ZIP64 and multi-disk archives are not
 * useful for an EPUB upload and are rejected rather than partially parsed.
 */
export function assertSafeEpubArchive(
  bytes: Uint8Array,
  limits: EpubArchiveLimits = DEFAULT_EPUB_ARCHIVE_LIMITS,
): void {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new EpubArchiveLimitError(
      `EPUB exceeds the ${limits.maxArchiveBytes}-byte compressed-size limit`,
    );
  }
  if (bytes.byteLength < ZIP_EOCD_MIN_BYTES) {
    throw new Error("Invalid EPUB: ZIP archive is truncated");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (
    diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    throw new EpubArchiveLimitError("Multi-disk and ZIP64 EPUB archives are not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new EpubArchiveLimitError(
      `EPUB contains ${entryCount} entries; limit is ${limits.maxEntries}`,
    );
  }
  if (centralOffset + centralSize > eocdOffset) {
    throw new Error("Invalid EPUB: ZIP central directory is out of bounds");
  }

  const decoder = new TextDecoder();
  const names = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      throw new Error("Invalid EPUB: malformed ZIP central directory");
    }

    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || nextOffset > eocdOffset) {
      throw new Error("Invalid EPUB: malformed ZIP entry metadata");
    }

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    if (unsafeArchivePath(name)) {
      throw new EpubArchiveLimitError(`EPUB contains an unsafe archive path: ${name}`);
    }
    if (names.has(name)) {
      throw new Error(`Invalid EPUB: duplicate ZIP entry ${name}`);
    }
    names.add(name);

    totalUncompressed += uncompressedBytes;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      throw new EpubArchiveLimitError(
        `EPUB expands beyond the ${limits.maxUncompressedBytes}-byte limit`,
      );
    }
    offset = nextOffset;
  }

  if (offset !== centralOffset + centralSize) {
    throw new Error("Invalid EPUB: ZIP central-directory size mismatch");
  }
}

export function parseEpub(
  bytes: Uint8Array,
  limits: EpubArchiveLimits = DEFAULT_EPUB_ARCHIVE_LIMITS,
): Epub {
  assertSafeEpubArchive(bytes, limits);
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

  // dc:title (may be a string or a node with #text / attributes).
  const rawTitle = asArray(pkg.metadata?.["dc:title"])[0];
  const title =
    typeof rawTitle === "string"
      ? rawTitle.trim()
      : typeof rawTitle?.["#text"] === "string"
        ? rawTitle["#text"].trim()
        : undefined;

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

  return { entries, opfPath, title, spine };
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
