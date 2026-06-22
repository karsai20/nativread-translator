import { test, expect } from "bun:test";
import { protect, restore, stripInlineTags } from "../src/core/markup.ts";

test("protect/restore round-trips inline markup losslessly", () => {
  const html = 'He found a <a href="ch2.xhtml">letter</a> from <em>Sarah</em>.';
  const { text, tokens } = protect(html);

  expect(tokens.length).toBe(4); // <a>, </a>, <em>, </em>
  expect(text).not.toContain("<");
  expect(restore(text, tokens)).toBe(html);
});

test("tokens survive a token-preserving translation", () => {
  const html = "A <strong>cold</strong> morning.<br/>The fire was out.";
  const { text, tokens } = protect(html);

  // Simulate a translator: uppercase words but leave tokens untouched.
  const fakeTranslated = text.replace(/[a-z]+/g, (w) => w.toUpperCase());

  const restored = restore(fakeTranslated, tokens);
  expect(restored).toContain("<strong>");
  expect(restored).toContain("</strong>");
  expect(restored).toContain("<br/>");
});

test("restore tolerates whitespace the model inserts around tokens", () => {
  const html = "a <em>b</em> c";
  const { text, tokens } = protect(html);
  // Model nudges spacing around the token markers.
  const nudged = text.replace(/()(\d+)()/g, " $1$2$3 ");
  expect(restore(nudged, tokens)).toContain("<em>");
  expect(restore(nudged, tokens)).toContain("</em>");
});

test("stripInlineTags removes inline tags but keeps block tags", () => {
  const html = "<p>Hello <em>world</em></p>";
  expect(stripInlineTags(html)).toBe("<p>Hello world</p>");
});
