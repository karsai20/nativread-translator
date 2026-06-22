// Inline-tag protection + block-boundary markers.
//
// Two separate placeholder schemes, both using Unicode Private Use Area code points so
// they never collide with real prose and survive translation intact:
//
//   1. Inline tokens  — replace inline tags (<em>, <a href>, <br/>, ...) inside a block.
//   2. Block markers  — separate several blocks (paragraphs) inside ONE translation
//      request, so the model sees a whole passage at once for context, yet we can still
//      map each translated paragraph back to its source block.
//
// Both are string-only (no DOM) so the design ports cleanly to Swift.

// ---- Inline tag tokens ----
const TOKEN_OPEN = "";
const TOKEN_CLOSE = "";

// ---- Block boundary markers (distinct PUA range) ----
const BLOCK_OPEN = "";
const BLOCK_CLOSE = "";

const INLINE_TAGS = [
  "a", "abbr", "b", "br", "cite", "code", "del", "em", "i", "img", "ins", "mark",
  "q", "s", "small", "span", "strong", "sub", "sup", "time", "u", "wbr",
] as const;

const INLINE_SET = new Set<string>(INLINE_TAGS);

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;

export interface ProtectedMarkup {
  text: string;
  tokens: string[];
}

/** Replace inline tags with placeholder tokens. */
export function protect(html: string): ProtectedMarkup {
  const tokens: string[] = [];
  const text = html.replace(TAG_RE, (match, rawName: string) => {
    if (!INLINE_SET.has(rawName.toLowerCase())) return match;
    const index = tokens.length;
    tokens.push(match);
    return `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`;
  });
  return { text, tokens };
}

/** Swap placeholder tokens back to their original tag strings. */
export function restore(text: string, tokens: string[]): string {
  const re = new RegExp(`${TOKEN_OPEN}\\s*(\\d+)\\s*${TOKEN_CLOSE}`, "g");
  return text.replace(re, (_m, n: string) => tokens[Number(n)] ?? "");
}

/** Strip all inline tags entirely (e.g. for glossary seeding / plain-text context). */
export function stripInlineTags(html: string): string {
  return html.replace(TAG_RE, (match, rawName: string) =>
    INLINE_SET.has(rawName.toLowerCase()) ? "" : match,
  );
}

// ---- Block markers ----

/** Marker that introduces block number `i` in a multi-block payload. */
export function blockMarker(i: number): string {
  return `${BLOCK_OPEN}${i}${BLOCK_CLOSE}`;
}

export interface BlockSegment {
  index: number;
  body: string;
}

/**
 * Split a translated multi-block payload back into per-block segments, keyed by the
 * block index embedded in each marker. Anything before the first marker is ignored
 * (covers a model that prepends a stray line).
 */
export function splitBlockSegments(text: string): BlockSegment[] {
  const re = new RegExp(`${BLOCK_OPEN}(\\d+)${BLOCK_CLOSE}`, "g");
  const hits: { index: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hits.push({ index: Number(m[1]), start: m.index, end: re.lastIndex });
  }
  return hits.map((h, i) => {
    const bodyEnd = i + 1 < hits.length ? hits[i + 1]!.start : text.length;
    return { index: h.index, body: text.slice(h.end, bodyEnd) };
  });
}

export const PLACEHOLDER_OPEN = TOKEN_OPEN;
export const PLACEHOLDER_CLOSE = TOKEN_CLOSE;
export const BLOCK_MARKER_OPEN = BLOCK_OPEN;
export const BLOCK_MARKER_CLOSE = BLOCK_CLOSE;
