import { test, expect } from "bun:test";
import { chunkSpineItem, CHUNK_CHAR_BUDGET } from "../lib/core/chunker.ts";

const doc = (body: string) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

test("extracts leaf block elements in document order", () => {
  const { blockEls } = chunkSpineItem(
    "ch1.xhtml",
    doc("<h1>Title</h1><p>One</p><p>Two</p>"),
  );
  expect(blockEls.map((e) => e.innerHTML)).toEqual(["Title", "One", "Two"]);
});

test("groups small blocks into a single chunk", () => {
  const { chunks } = chunkSpineItem("ch1.xhtml", doc("<p>a</p><p>b</p><p>c</p>"));
  expect(chunks.length).toBe(1);
  expect(chunks[0]!.blocks.length).toBe(3);
  expect(chunks[0]!.key).toBe("ch1.xhtml#0");
});

test("splits into multiple chunks when over the char budget", () => {
  const big = "x".repeat(CHUNK_CHAR_BUDGET);
  const { chunks } = chunkSpineItem("ch1.xhtml", doc(`<p>${big}</p><p>${big}</p>`));
  expect(chunks.length).toBe(2);
  expect(chunks[0]!.key).toBe("ch1.xhtml#0");
  expect(chunks[1]!.key).toBe("ch1.xhtml#1");
});

test("re-stitch by block index updates the right element", () => {
  const { doc: parsed, blockEls } = chunkSpineItem(
    "ch1.xhtml",
    doc("<p>One</p><p>Two</p>"),
  );
  blockEls[1]!.set_content("KETTO");
  expect(parsed.toString()).toContain("<p>KETTO</p>");
  expect(parsed.toString()).toContain("<p>One</p>");
});
