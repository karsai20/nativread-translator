// E1/E2 validation: the Art 50 marker layers exist in the delivered EPUB,
// use the exact pinned spec, survive a re-zip round-trip, and the marked
// EPUB still parses as a valid EPUB (container -> OPF -> spine).

import { test, expect } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { parseEpub, writeEpub } from "../lib/core/epub.ts";
import {
  injectAiMarker,
  markerSentence,
  DIGITAL_SOURCE_TYPE_URI,
  IPTC_PREFIX_DECL,
  COLOPHON_HREF,
  COLOPHON_ID,
} from "../lib/core/ai-marker.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

const OPTS = { sourceLang: "en", targetLang: "hu", date: "2026-07-09" };

function markedEpubBytes(): Uint8Array {
  const epub = parseEpub(buildFixtureEpub());
  injectAiMarker(epub, OPTS);
  return writeEpub(epub, {});
}

test("OPF carries the exact pinned marker spec", () => {
  const entries = unzipSync(markedEpubBytes());
  const opf = strFromU8(entries["OEBPS/content.opf"]!);

  // Layer 1: IPTC DigitalSourceType via the EPUB prefix mechanism.
  expect(opf).toContain(`prefix="${IPTC_PREFIX_DECL}"`);
  expect(opf).toContain(
    `<meta property="iptc:DigitalSourceType">${DIGITAL_SOURCE_TYPE_URI}</meta>`,
  );

  // Layer 2: dc: entry with the human+machine sentence.
  expect(opf).toContain('<dc:description id="nativread-web-ai-marker">');
  expect(opf).toContain(markerSentence(OPTS));

  // Layer 3: colophon in manifest + spine.
  expect(opf).toContain(`href="${COLOPHON_HREF}"`);
  expect(opf).toContain(`<itemref idref="${COLOPHON_ID}"/>`);
});

test("colophon page ships and is human-readable in both languages", () => {
  const entries = unzipSync(markedEpubBytes());
  const colophon = strFromU8(entries[`OEBPS/${COLOPHON_HREF}`]!);

  expect(colophon).toContain("AI translation by NativRead Web");
  expect(colophon).toContain("mesterséges intelligencia");
  expect(colophon).toContain("Article 50");
  expect(colophon).toContain("2026-07-09");
});

test("marked EPUB stays valid and the marker survives a re-zip round-trip", () => {
  // First round: parse the marked EPUB (validity: container -> OPF -> spine).
  const reparsed = parseEpub(markedEpubBytes());
  expect(reparsed.title).toBe("Test Book");
  expect(reparsed.spine.map((s) => s.href)).toEqual([
    "OEBPS/ch1.xhtml",
    "OEBPS/ch2.xhtml",
    `OEBPS/${COLOPHON_HREF}`,
  ]);

  // Second round: re-zip with no changes (a faithful re-export) and re-parse.
  const roundTripped = parseEpub(writeEpub(reparsed, {}));
  const opf = strFromU8(roundTripped.entries["OEBPS/content.opf"]!);
  expect(opf).toContain(DIGITAL_SOURCE_TYPE_URI);
  expect(roundTripped.spine.at(-1)!.content).toContain("AI translation by NativRead Web");

  // mimetype stays first and stored.
  const entries = unzipSync(writeEpub(roundTripped, {}));
  expect(Object.keys(entries)[0]).toBe("mimetype");
  expect(strFromU8(entries["mimetype"]!)).toBe("application/epub+zip");
});

test("injection is idempotent — a re-run delivery does not stack markers", () => {
  const epub = parseEpub(buildFixtureEpub());
  injectAiMarker(epub, OPTS);
  const once = strFromU8(epub.entries["OEBPS/content.opf"]!);
  injectAiMarker(epub, OPTS);
  const twice = strFromU8(epub.entries["OEBPS/content.opf"]!);
  expect(twice).toBe(once);
  expect(twice.split(IPTC_PREFIX_DECL).length - 1).toBe(1);
});

test("appends to an existing package prefix attribute instead of clobbering it", () => {
  const epub = parseEpub(buildFixtureEpub());
  const opf = strFromU8(epub.entries["OEBPS/content.opf"]!).replace(
    "<package ",
    '<package prefix="schema: http://schema.org/" ',
  );
  epub.entries["OEBPS/content.opf"] = new TextEncoder().encode(opf);

  injectAiMarker(epub, OPTS);

  const marked = strFromU8(epub.entries["OEBPS/content.opf"]!);
  expect(marked).toContain(`prefix="schema: http://schema.org/ ${IPTC_PREFIX_DECL}"`);
});

test("handles a single-quoted prefix attribute without emitting a second one", () => {
  const epub = parseEpub(buildFixtureEpub());
  const opf = strFromU8(epub.entries["OEBPS/content.opf"]!).replace(
    "<package ",
    "<package prefix='schema: http://schema.org/' ",
  );
  epub.entries["OEBPS/content.opf"] = new TextEncoder().encode(opf);

  injectAiMarker(epub, OPTS);

  const marked = strFromU8(epub.entries["OEBPS/content.opf"]!);
  expect(marked).toContain(`prefix="schema: http://schema.org/ ${IPTC_PREFIX_DECL}"`);
  expect(marked.match(/\bprefix\s*=/g)!.length).toBe(1);
});

test("tolerates whitespace inside close tags (</metadata >)", () => {
  const epub = parseEpub(buildFixtureEpub());
  const opf = strFromU8(epub.entries["OEBPS/content.opf"]!)
    .replace("</metadata>", "</metadata >")
    .replace("</manifest>", "</manifest >")
    .replace("</spine>", "</spine >");
  epub.entries["OEBPS/content.opf"] = new TextEncoder().encode(opf);

  injectAiMarker(epub, OPTS);

  const marked = strFromU8(epub.entries["OEBPS/content.opf"]!);
  expect(marked).toContain(DIGITAL_SOURCE_TYPE_URI);
  expect(marked).toContain(`<itemref idref="${COLOPHON_ID}"/>`);
});

test("a publisher's pre-existing trainedAlgorithmicMedia mark does not suppress our layers", () => {
  const epub = parseEpub(buildFixtureEpub());
  const opf = strFromU8(epub.entries["OEBPS/content.opf"]!).replace(
    "</metadata>",
    `  <meta property="iptc:DigitalSourceType">${DIGITAL_SOURCE_TYPE_URI}</meta>\n  </metadata>`,
  );
  epub.entries["OEBPS/content.opf"] = new TextEncoder().encode(opf);

  injectAiMarker(epub, OPTS);

  const marked = strFromU8(epub.entries["OEBPS/content.opf"]!);
  expect(marked).toContain('id="nativread-web-ai-marker"');
  expect(marked).toContain(`<itemref idref="${COLOPHON_ID}"/>`);
});

test("fails loudly on an OPF without a metadata block", () => {
  const epub = parseEpub(buildFixtureEpub());
  const opf = strFromU8(epub.entries["OEBPS/content.opf"]!)
    .replace(/<metadata[\s\S]*?<\/metadata>/, "");
  epub.entries["OEBPS/content.opf"] = new TextEncoder().encode(opf);

  expect(() => injectAiMarker(epub, OPTS)).toThrow("no <metadata>");
});
