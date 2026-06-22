// Chunker: split a spine-item's XHTML into model-sized chunks of block elements.
//
// A chunk is the translation UNIT: all of its blocks are translated together in one
// request so the model has full passage context. We therefore make chunks as large as
// the model can comfortably handle in a single round-trip (bigger = fewer seams = better
// continuity), sub-chunking only long chapters. Each block keeps its document-order
// index so the job can re-stitch translated inner HTML back into the exact position.

import { parse, type HTMLElement } from "node-html-parser";

export const CHARS_PER_TOKEN = 4;
// ~2000 source tokens/chunk: large enough to translate most chapters whole, small
// enough that the Hungarian output stays well under the model's output limit.
const CHUNK_TOKEN_BUDGET = 2000;
export const CHUNK_CHAR_BUDGET = CHUNK_TOKEN_BUDGET * CHARS_PER_TOKEN;

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
  "figcaption", "dd", "dt", "td", "th", "caption",
]);

export interface Block {
  index: number;
  innerHtml: string;
}

export interface Chunk {
  key: string;
  itemHref: string;
  blocks: Block[];
}

function collectBlocks(root: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  const visit = (el: HTMLElement) => {
    const tag = el.tagName?.toLowerCase();
    if (tag && BLOCK_TAGS.has(tag)) {
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

export function chunkSpineItem(
  itemHref: string,
  xhtml: string,
): { chunks: Chunk[]; doc: HTMLElement; blockEls: HTMLElement[] } {
  const doc = parse(xhtml, { comment: true, voidTag: { closingSlash: true } });
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
    if (currentChars > 0 && currentChars + len > CHUNK_CHAR_BUDGET) flush();
    current.push({ index, innerHtml });
    currentChars += len;
    if (currentChars >= CHUNK_CHAR_BUDGET) flush();
  });

  flush();
  return { chunks, doc, blockEls };
}
