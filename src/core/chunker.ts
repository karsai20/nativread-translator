// Chunker: split a spine-item's XHTML into model-sized chunks of block elements.
//
// We operate at block granularity (p, h1..h6, li, blockquote, ...). Each block keeps
// its index so the job can re-stitch translated inner HTML back into exactly the same
// position. Blocks are grouped into chunks under a character budget that approximates
// the model's token budget.

import { parse, type HTMLElement } from "node-html-parser";

// ~4 chars per token is the usual English rule of thumb. The budget is per chunk of
// text we hand to the model in one request.
export const CHARS_PER_TOKEN = 4;
const CHUNK_TOKEN_BUDGET = 1500;
export const CHUNK_CHAR_BUDGET = CHUNK_TOKEN_BUDGET * CHARS_PER_TOKEN;

// Block-level tags we translate as discrete units.
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "figcaption",
  "dd",
  "dt",
  "td",
  "th",
  "caption",
]);

export interface Block {
  /** Stable position within the spine item (document order of extracted blocks). */
  index: number;
  innerHtml: string;
}

export interface Chunk {
  /** Unique key within a job: `${itemHref}#${ordinal}`. */
  key: string;
  itemHref: string;
  blocks: Block[];
}

/** Walk the parsed body in document order, collecting leaf-most block elements. */
function collectBlocks(root: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];

  const visit = (el: HTMLElement) => {
    const tag = el.tagName?.toLowerCase();
    if (tag && BLOCK_TAGS.has(tag)) {
      // A block that contains no nested translatable block is a leaf we translate.
      const hasNestedBlock = el
        .querySelectorAll("*")
        .some((c) => BLOCK_TAGS.has(c.tagName?.toLowerCase() ?? ""));
      if (!hasNestedBlock) {
        blocks.push(el);
        return;
      }
    }
    for (const child of el.childNodes) {
      if ((child as HTMLElement).tagName !== undefined) visit(child as HTMLElement);
    }
  };

  visit(root);
  return blocks;
}

/**
 * Split one spine item's XHTML into chunks. Returns the chunks plus the parsed
 * document and the ordered block elements so the job can re-stitch in place.
 */
export function chunkSpineItem(
  itemHref: string,
  xhtml: string,
): { chunks: Chunk[]; doc: HTMLElement; blockEls: HTMLElement[] } {
  const doc = parse(xhtml, {
    comment: true,
    voidTag: { closingSlash: true },
  });

  const body = doc.querySelector("body") ?? doc;
  const blockEls = collectBlocks(body);

  const chunks: Chunk[] = [];
  let current: Block[] = [];
  let currentChars = 0;
  let ordinal = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ key: `${itemHref}#${ordinal++}`, itemHref, blocks: current });
    current = [];
    currentChars = 0;
  };

  blockEls.forEach((el, index) => {
    const innerHtml = el.innerHTML;
    const len = innerHtml.length;

    // A single oversized block still becomes its own chunk (we never split inside a
    // block — that would risk breaking markup); otherwise pack up to the budget.
    if (currentChars > 0 && currentChars + len > CHUNK_CHAR_BUDGET) flush();

    current.push({ index, innerHtml });
    currentChars += len;

    if (currentChars >= CHUNK_CHAR_BUDGET) flush();
  });

  flush();

  return { chunks, doc, blockEls };
}
