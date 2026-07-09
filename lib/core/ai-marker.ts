// EU AI Act Art 50(2) machine-readable AI marker + colophon (T25 backend half / E1).
//
// Spec (pinned 2026-07-09, recorded in nativread/docs/blueprint.md §5):
// the EC Code of Practice on Transparency of AI-Generated Content (final,
// 2026-06-10) prescribes marking *mechanisms* (layered machine-readable
// metadata) but names no property vocabulary for text publications. We
// therefore express the industry-standard machine-readable value — IPTC
// DigitalSourceType = trainedAlgorithmicMedia — through EPUB 3's package
// prefix mechanism, and layer it per the CoP's multi-layer guidance:
//
//   layer 1  <meta property="iptc:DigitalSourceType"> …/trainedAlgorithmicMedia
//   layer 2  <dc:description id="nativbook-ai-marker"> human+machine sentence
//   layer 3  colophon.xhtml appended to the spine (human-readable companion;
//            survives OPF-stripping conversions such as Send-to-Kindle)
//
// All three ride the OPF/spine, so any faithful EPUB re-zip or re-export
// keeps them (round-trip asserted in test/ai-marker.test.ts).
//
// Injection is done with targeted string edits on the raw OPF text — never a
// parse/re-serialize cycle — so every byte we did not intend to touch stays
// identical and the archive remains valid.

import { strToU8, strFromU8 } from "fflate";
import type { Epub } from "./epub";

export const IPTC_PREFIX_DECL = "iptc: http://iptc.org/std/Iptc4xmpExt/2008-02-29/";
export const DIGITAL_SOURCE_TYPE_URI =
  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
export const COLOPHON_HREF = "nativbook-colophon.xhtml";
export const COLOPHON_ID = "nativbook-colophon";

export interface AiMarkerOptions {
  /** BCP-47 source language tag, e.g. "en". */
  sourceLang: string;
  /** BCP-47 target language tag, e.g. "hu". */
  targetLang: string;
  /** ISO date of delivery; defaults to today (UTC). */
  date?: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  hu: "Hungarian",
  de: "German",
  es: "Spanish",
};

function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag] ?? tag;
}

export function markerSentence(opts: AiMarkerOptions): string {
  return (
    `AI-generated content: machine translation from ${languageName(opts.sourceLang)} ` +
    `to ${languageName(opts.targetLang)} by NativBook (EU AI Act Art 50).`
  );
}

function colophonXhtml(opts: AiMarkerOptions, date: string): string {
  const hu =
    opts.targetLang === "hu"
      ? "<p>Ezt a könyvet mesterséges intelligencia fordította a NativBook alkalmazásban, " +
        "a tulajdonos saját példányából. A fordítás géppel készült, hibákat tartalmazhat.</p>\n"
      : "";
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    "<!DOCTYPE html>\n" +
    '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
    "<head><title>Colophon</title></head>\n" +
    "<body>\n" +
    "<h2>AI translation by NativBook</h2>\n" +
    hu +
    `<p>This book was machine-translated from ${languageName(opts.sourceLang)} to ` +
    `${languageName(opts.targetLang)} by NativBook on ${date}. It is AI-generated ` +
    "content under Article 50 of the EU AI Act and may contain translation errors. " +
    "The translation was made for the personal use of the book's owner.</p>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

/**
 * Injects the Art 50 marker layers into `epub` in place: OPF metadata edits
 * plus a colophon spine item. Call before `writeEpub`. Throws if the OPF does
 * not have the expected shape — a silently unmarked delivery is a compliance
 * failure, so this path fails loudly.
 */
export function injectAiMarker(epub: Epub, opts: AiMarkerOptions): void {
  const opfBytes = epub.entries[epub.opfPath];
  if (!opfBytes) throw new Error(`AI marker: OPF not found at ${epub.opfPath}`);
  let opf = strFromU8(opfBytes);
  // Idempotent: a resumed/re-run delivery must not stack duplicate markers.
  if (opf.includes(DIGITAL_SOURCE_TYPE_URI)) return;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  // 1. Declare the IPTC prefix on <package>. Append to an existing prefix
  //    attribute, otherwise add one.
  if (!opf.includes(IPTC_PREFIX_DECL)) {
    const packageTag = opf.match(/<package\b[^>]*>/);
    if (!packageTag) throw new Error("AI marker: OPF has no <package> tag");
    const existingPrefix = packageTag[0].match(/\bprefix\s*=\s*"([^"]*)"/);
    const updatedTag = existingPrefix
      ? packageTag[0].replace(existingPrefix[0], `prefix="${existingPrefix[1]} ${IPTC_PREFIX_DECL}"`)
      : packageTag[0].replace(/<package\b/, `<package prefix="${IPTC_PREFIX_DECL}"`);
    opf = opf.replace(packageTag[0], updatedTag);
  }

  // 2. Marker metadata, inserted just before </metadata>.
  if (!opf.includes("</metadata>")) throw new Error("AI marker: OPF has no <metadata> block");
  const metadata =
    `    <meta property="iptc:DigitalSourceType">${DIGITAL_SOURCE_TYPE_URI}</meta>\n` +
    `    <dc:description id="nativbook-ai-marker">${markerSentence(opts)}</dc:description>\n`;
  opf = opf.replace("</metadata>", `${metadata}  </metadata>`);

  // 3. Colophon page: manifest item + last spine itemref + the XHTML entry.
  if (!opf.includes("</manifest>") || !opf.includes("</spine>")) {
    throw new Error("AI marker: OPF has no manifest/spine");
  }
  opf = opf.replace(
    "</manifest>",
    `  <item id="${COLOPHON_ID}" href="${COLOPHON_HREF}" media-type="application/xhtml+xml"/>\n  </manifest>`,
  );
  opf = opf.replace("</spine>", `  <itemref idref="${COLOPHON_ID}"/>\n  </spine>`);

  const opfDir = epub.opfPath.includes("/")
    ? epub.opfPath.slice(0, epub.opfPath.lastIndexOf("/") + 1)
    : "";
  epub.entries[`${opfDir}${COLOPHON_HREF}`] = strToU8(colophonXhtml(opts, date));
  epub.entries[epub.opfPath] = strToU8(opf);
}
