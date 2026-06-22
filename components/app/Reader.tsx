"use client";

import * as React from "react";
import DOMPurify from "dompurify";
import { Eye, EyeOff, Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReaderItem } from "./types";

function blocksOf(html: string): Element[] {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  const root = doc.getElementById("r");
  return root ? Array.from(root.children) : [];
}

function Chapter({ item }: { item: ReaderItem }) {
  // Interleave translated block + (muted) original block, paragraph by paragraph.
  // The book content is untrusted (user-uploaded EPUB + model output), so the combined
  // HTML is sanitized with DOMPurify before it is ever inserted into the DOM.
  const html = React.useMemo(() => {
    const trans = blocksOf(item.translatedHtml);
    const orig = blocksOf(item.originalHtml);
    const parts: string[] = [];
    trans.forEach((tb, i) => {
      parts.push(tb.outerHTML);
      const o = orig[i]?.textContent?.trim();
      if (o) parts.push(`<span class="orig">${o.replace(/</g, "&lt;")}</span>`);
    });
    return DOMPurify.sanitize(parts.join(""), { USE_PROFILES: { html: true } });
  }, [item]);

  return (
    <section
      className="border-b border-border pb-8 last:border-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface ReaderProps {
  items: ReaderItem[];
  downloadHref: string;
}

export function Reader({ items, downloadHref }: ReaderProps) {
  const [showOriginal, setShowOriginal] = React.useState(false);
  const hasOriginal = items.some((i) => i.originalHtml.trim().length > 0);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-3xl sm:text-4xl">Kész! Olvashatod.</h1>
        <div className="flex gap-2">
          {hasOriginal && (
            <Button variant="ghost" aria-pressed={showOriginal} onClick={() => setShowOriginal((v) => !v)}>
              {showOriginal ? <EyeOff /> : <Eye />}
              {showOriginal ? "Eredeti elrejtése" : "Eredeti megjelenítése"}
            </Button>
          )}
          <a href={downloadHref} download className={cn(buttonVariants())}>
            <Download />
            Letöltés (EPUB)
          </a>
        </div>
      </div>

      <Card>
        <div className={cn("prose-reader p-6 sm:p-10", !showOriginal && "hide-original")}>
          {items.map((item) => (
            <Chapter key={item.href} item={item} />
          ))}
        </div>
      </Card>
    </section>
  );
}
