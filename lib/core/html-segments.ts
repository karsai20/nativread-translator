// DOM-aware text extraction for translation.
//
// The translator must not ask an LLM to preserve HTML. We keep the original DOM tree
// and attributes locally, send only text-node contents with stable markers, then write
// translated text back into the original text nodes. If a model drops those markers,
// callers can fall back to translating individual text nodes; links and formatting still
// never leave this process.

import { parse } from "node-html-parser";
import type Node from "node-html-parser/dist/nodes/node";
import type TextNode from "node-html-parser/dist/nodes/text";
import type HTMLElement from "node-html-parser/dist/nodes/html";
import NodeType from "node-html-parser/dist/nodes/type";

export const TEXT_SEGMENT_OPEN = "⟦";
export const TEXT_SEGMENT_CLOSE = "⟧";

interface SegmentRef {
  index: number;
  node: TextNode;
  sourceCore: string;
  leading: string;
  trailing: string;
}

export interface TextSegment {
  index: number;
  text: string;
}

export interface ProtectedHtmlText {
  originalHtml: string;
  text: string;
  segments: TextSegment[];
  sourcePlain: string;
  restore(translatedText: string): string | undefined;
  restoreFromSegments(translations: Map<number, string>): string;
}

function segmentMarker(index: number): string {
  return `${TEXT_SEGMENT_OPEN}${index}${TEXT_SEGMENT_CLOSE}`;
}

function splitWhitespace(s: string): { leading: string; core: string; trailing: string } {
  const leading = s.match(/^\s*/)?.[0] ?? "";
  const trailing = s.match(/\s*$/)?.[0] ?? "";
  const core = s.slice(leading.length, s.length - trailing.length);
  return { leading, core, trailing };
}

function walkTextNodes(node: Node, out: TextNode[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    out.push(node as TextNode);
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  for (const child of (node as HTMLElement).childNodes) walkTextNodes(child, out);
}

export function splitTextSegments(text: string): Map<number, string> {
  const re = new RegExp(`${TEXT_SEGMENT_OPEN}\\s*(\\d+)\\s*${TEXT_SEGMENT_CLOSE}`, "g");
  const hits: { index: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hits.push({ index: Number(m[1]), start: m.index, end: re.lastIndex });
  }

  const byIndex = new Map<number, string>();
  const preamble = hits.length > 0 ? text.slice(0, hits[0]!.start) : "";
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const bodyEnd = i + 1 < hits.length ? hits[i + 1]!.start : text.length;
    const prefix = i === 0 ? preamble : "";
    byIndex.set(h.index, `${prefix}${text.slice(h.end, bodyEnd)}`);
  }
  return byIndex;
}

function normalizeTranslatedCore(translated: string): string {
  return translated.replace(/^\s+/, "").replace(/\s+$/, "");
}

const HTML_TEXT_ESCAPE_RE = /[&<>]/gu;
const HTML_TEXT_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Escapes only HTML text-node delimiters; quotes are not special here. */
function escapeHtmlText(text: string): string {
  return text.replace(HTML_TEXT_ESCAPE_RE, (character) => HTML_TEXT_ESCAPES[character]!);
}

export function protectHtmlTextNodes(html: string): ProtectedHtmlText {
  const doc = parse(`<nativread-block>${html}</nativread-block>`, {
    comment: true,
    voidTag: { closingSlash: true },
  });
  const wrapper = doc.querySelector("nativread-block") ?? doc;
  const textNodes: TextNode[] = [];
  walkTextNodes(wrapper, textNodes);

  const refs: SegmentRef[] = [];
  for (const node of textNodes) {
    const { leading, core, trailing } = splitWhitespace(node.text);
    if (core.length === 0) continue;
    refs.push({
      index: refs.length,
      node,
      sourceCore: core,
      leading,
      trailing,
    });
  }

  const segments = refs.map((r) => ({ index: r.index, text: r.sourceCore }));
  const payload = segments.map((s) => `${segmentMarker(s.index)}${s.text}`).join("\n");

  const restoreFromSegments = (translations: Map<number, string>): string => {
    for (const ref of refs) {
      const translated = translations.get(ref.index);
      if (translated === undefined) continue;
      // `rawText` is serialized as markup, so escape the provider response for
      // text-node context while preserving literal Unicode in the EPUB.
      ref.node.rawText = escapeHtmlText(
        `${ref.leading}${normalizeTranslatedCore(translated)}${ref.trailing}`,
      );
    }
    return wrapper.innerHTML;
  };

  return {
    originalHtml: html,
    text: payload,
    segments,
    sourcePlain: segments.map((s) => s.text).join(" "),
    restore(translatedText: string): string | undefined {
      const translations = splitTextSegments(translatedText);
      const allPresent = refs.every((r) => translations.has(r.index));
      if (!allPresent) return undefined;
      return restoreFromSegments(translations);
    },
    restoreFromSegments,
  };
}
