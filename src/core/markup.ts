// Inline-tag protection via placeholder tokens.
//
// The source is XHTML. We want the model to translate prose without mangling
// inline markup (<em>, <a href>, <br/>, ...). The approach: replace every inline
// tag with an opaque placeholder token, send the tokenized text to the model,
// then swap the original tags back in. Tokens use Unicode Private Use Area code
// points so they will never appear in real prose and survive translation intact.
//
// This is intentionally string-only (no DOM): it ports cleanly to Swift.

const TOKEN_OPEN = ""; // PUA
const TOKEN_CLOSE = ""; // PUA

// Inline elements whose tags we protect. Anything else (p, div, h1...) is treated
// as block structure and handled by the chunker, not here.
const INLINE_TAGS = [
  "a",
  "abbr",
  "b",
  "br",
  "cite",
  "code",
  "del",
  "em",
  "i",
  "img",
  "ins",
  "mark",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "wbr",
] as const;

const INLINE_SET = new Set<string>(INLINE_TAGS);

// Matches an opening, closing, or self-closing tag, capturing the tag name.
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;

export interface ProtectedMarkup {
  /** Text with inline tags replaced by tokens; block-irrelevant entities preserved. */
  text: string;
  /** Original tag strings, indexed; token i maps to tokens[i]. */
  tokens: string[];
}

/** Replace inline tags with placeholder tokens. */
export function protect(html: string): ProtectedMarkup {
  const tokens: string[] = [];
  const text = html.replace(TAG_RE, (match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!INLINE_SET.has(name)) {
      // Leave block-level / unknown tags untouched so the caller can decide.
      return match;
    }
    const index = tokens.length;
    tokens.push(match);
    return `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`;
  });
  return { text, tokens };
}

/** Swap placeholder tokens back to their original tag strings. */
export function restore(text: string, tokens: string[]): string {
  // Replace any ⟦n⟧ token; tolerate the model adding/removing whitespace around it.
  const re = new RegExp(`${TOKEN_OPEN}\\s*(\\d+)\\s*${TOKEN_CLOSE}`, "g");
  return text.replace(re, (_match, numStr: string) => {
    const index = Number(numStr);
    return tokens[index] ?? "";
  });
}

/** Strip all inline tags entirely — used to extract plain text (e.g. glossary seeding). */
export function stripInlineTags(html: string): string {
  return html.replace(TAG_RE, (match, rawName: string) =>
    INLINE_SET.has(rawName.toLowerCase()) ? "" : match,
  );
}

export const PLACEHOLDER_OPEN = TOKEN_OPEN;
export const PLACEHOLDER_CLOSE = TOKEN_CLOSE;
