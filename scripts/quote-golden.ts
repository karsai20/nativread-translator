// Generates the golden quote fixture the Swift port is verified against.
//
// The price a reader sees can be computed on the device only if the device
// agrees with the server to the character. "Agrees" is not a claim to make in a
// comment — it is a fixture: this script runs the real server-side counter over
// real books and writes down the exact numbers, and the Swift test asserts it
// reproduces them. Any drift in either implementation fails a test instead of
// charging someone the wrong tier.
//
//   bun run scripts/quote-golden.ts <book.epub ...> > quote-golden.json
//
// Point it at the widest set of books available — different producers (Calibre,
// Standard Ebooks, Gutenberg, InDesign, web-novel exports) disagree about
// entities, whitespace and markup, which is exactly what the port has to match.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";

import { parseEpub } from "../lib/core/epub";
import { countSourceCharacters, quoteForEpub } from "../lib/core/metering";

interface GoldenEntry {
  file: string;
  /** SHA256 of the archive, so a fixture can be tied to exact bytes. */
  sha256: string;
  spineItems: number;
  sourceCharacters: number;
  requiredCredits: number;
  quoteVersion: string;
}

function golden(path: string): GoldenEntry {
  const bytes = new Uint8Array(readFileSync(path));
  const epub = parseEpub(bytes);
  const quote = quoteForEpub(epub);
  return {
    file: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    spineItems: epub.spine.length,
    // Recomputed on its own so a change to quoteForEpub's arithmetic cannot
    // silently pass by moving both numbers together.
    sourceCharacters: countSourceCharacters(epub),
    requiredCredits: quote.requiredCredits,
    quoteVersion: quote.version,
  };
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: bun run scripts/quote-golden.ts <book.epub ...>");
  process.exit(2);
}

const entries: GoldenEntry[] = [];
for (const path of paths) {
  try {
    entries.push(golden(path));
  } catch (error) {
    // A book the server itself cannot parse has no golden number to match, and
    // must not silently become a zero the Swift side would "agree" with.
    console.error(`skipped ${path}: ${(error as Error).message}`);
  }
}

console.log(JSON.stringify({ quoteVersion: entries[0]?.quoteVersion, entries }, null, 2));
