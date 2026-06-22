import { test, expect } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { parseEpub, writeEpub } from "../src/core/epub.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

test("parses container -> OPF -> spine in order", () => {
  const epub = parseEpub(buildFixtureEpub());
  expect(epub.opfPath).toBe("OEBPS/content.opf");
  expect(epub.spine.map((s) => s.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
  expect(epub.spine[0]!.content).toContain("Mr. Holloway");
});

test("writeEpub puts mimetype first and stored, and re-parses", () => {
  const epub = parseEpub(buildFixtureEpub());
  const translated = {
    "OEBPS/ch1.xhtml": epub.spine[0]!.content.replace("Mr. Holloway", "Holloway úr"),
  };
  const out = writeEpub(epub, translated);

  // First entry must be mimetype.
  const entries = unzipSync(out);
  expect(Object.keys(entries)[0]).toBe("mimetype");
  expect(strFromU8(entries["mimetype"]!)).toBe("application/epub+zip");

  // Round-trip: re-parse and see the translated content.
  const reparsed = parseEpub(out);
  expect(reparsed.spine[0]!.content).toContain("Holloway úr");
  expect(reparsed.spine[1]!.content).toContain("Sarah Holloway"); // untouched item preserved
});
