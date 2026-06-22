// Builds a tiny but valid in-memory EPUB so tests never touch disk fixtures or binaries.

import { zipSync, strToU8 } from "fflate";

export interface FixtureChapter {
  href: string; // relative to OEBPS/
  id: string;
  title: string;
  body: string; // inner HTML of <body>
}

const DEFAULT_CHAPTERS: FixtureChapter[] = [
  {
    href: "ch1.xhtml",
    id: "ch1",
    title: "Chapter One",
    body:
      "<h1>Chapter One</h1>" +
      "<p>Mr. Holloway walked into the <em>old</em> library.</p>" +
      '<p>He found a <a href="ch2.xhtml">letter</a> from Sarah Holloway.</p>',
  },
  {
    href: "ch2.xhtml",
    id: "ch2",
    title: "Chapter Two",
    body:
      "<h1>Chapter Two</h1>" +
      "<p>Sarah Holloway had written to Mr. Holloway about the house.</p>" +
      "<p>It was a <strong>cold</strong> morning.<br/>The fire was out.</p>",
  },
];

function xhtmlDoc(title: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
    `<head><title>${title}</title></head>\n` +
    `<body>${body}</body>\n` +
    "</html>\n"
  );
}

export function buildFixtureEpub(chapters: FixtureChapter[] = DEFAULT_CHAPTERS): Uint8Array {
  const manifestItems = chapters
    .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join("\n      ");
  const spineItems = chapters.map((c) => `<itemref idref="${c.id}"/>`).join("\n      ");

  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    '    <dc:identifier id="bookid">urn:uuid:test-book</dc:identifier>\n' +
    "    <dc:title>Test Book</dc:title>\n" +
    "    <dc:language>en</dc:language>\n" +
    "  </metadata>\n" +
    `  <manifest>\n      ${manifestItems}\n  </manifest>\n` +
    `  <spine>\n      ${spineItems}\n  </spine>\n` +
    "</package>\n";

  const container =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    "  <rootfiles>\n" +
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
    "  </rootfiles>\n" +
    "</container>\n";

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
  };
  for (const c of chapters) {
    files[`OEBPS/${c.href}`] = strToU8(xhtmlDoc(c.title, c.body));
  }

  return zipSync(files as Record<string, Uint8Array>);
}
