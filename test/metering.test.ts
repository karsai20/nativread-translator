import { expect, test } from "bun:test";

import type { Epub } from "../lib/core/epub.ts";
import {
  CHARACTERS_PER_CREDIT,
  countSourceCharacters,
  quoteForEpub,
} from "../lib/core/metering.ts";

function epub(content: string): Epub {
  return {
    entries: {},
    opfPath: "content.opf",
    spine: [{
      id: "chapter",
      href: "chapter.xhtml",
      mediaType: "application/xhtml+xml",
      content,
    }],
  };
}

test("metering counts normalized visible source code points, not EPUB markup", () => {
  const book = epub(`
    <html><head><style>.x { color: red }</style></head><body>
      <p>Hello   <em>world</em> &amp; 😀</p>
      <p> Cafe\u0301 </p>
    </body></html>
  `);

  // "Hello world & 😀" = 15 code points; NFC "Café" = 4.
  expect(countSourceCharacters(book)).toBe(19);
});

test("quote rounds up by the documented 1,000-character credit unit", () => {
  const content = `<html><body><p>${"a".repeat(CHARACTERS_PER_CREDIT + 1)}</p></body></html>`;
  expect(quoteForEpub(epub(content))).toMatchObject({
    sourceCharacters: 1_001,
    requiredCredits: 2,
    charactersPerCredit: 1_000,
  });
});
