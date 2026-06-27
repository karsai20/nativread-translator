import { test, expect } from "bun:test";
import {
  protect,
  restore,
  stripInlineTags,
  hasResidualSentinel,
  PLACEHOLDER_OPEN,
  PLACEHOLDER_CLOSE,
} from "../lib/core/markup.ts";

test("protect/restore round-trips inline markup losslessly", () => {
  const html = 'He found a <a href="ch2.xhtml">letter</a> from <em>Sarah</em>.';
  const { text, tokens } = protect(html);

  expect(tokens.length).toBe(4); // <a>, </a>, <em>, </em>
  expect(text).not.toContain("<");
  expect(restore(text, tokens)).toBe(html);
});

test("protect uses visible sentinels, not invisible control chars", () => {
  const { text } = protect("A <strong>bold</strong> word.");
  // Visible bracket sentinels survive the model far better than PUA control chars.
  expect(text).toContain(PLACEHOLDER_OPEN);
  expect(text).toContain(PLACEHOLDER_CLOSE);
  expect(text).toContain(`${PLACEHOLDER_OPEN}0${PLACEHOLDER_CLOSE}`);
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
  // Model nudges spacing inside the token markers.
  const nudged = text.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, "g"),
    `${PLACEHOLDER_OPEN} $1 ${PLACEHOLDER_CLOSE}`,
  );
  expect(restore(nudged, tokens)).toContain("<em>");
  expect(restore(nudged, tokens)).toContain("</em>");
});

test("stripInlineTags removes inline tags but keeps block tags", () => {
  const html = "<p>Hello <em>world</em></p>";
  expect(stripInlineTags(html)).toBe("<p>Hello world</p>");
});

test("hasResidualSentinel detects a leaked token or marker", () => {
  expect(hasResidualSentinel("clean Hungarian text.")).toBe(false);
  expect(hasResidualSentinel(`leaked ${PLACEHOLDER_OPEN}3${PLACEHOLDER_CLOSE} token`)).toBe(true);
  expect(hasResidualSentinel("leaked 【2】 marker")).toBe(true);
});
