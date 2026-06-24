"use client";

import * as React from "react";
import DOMPurify from "dompurify";
import { Eye, EyeOff, Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReaderItem } from "@/lib/jobs/types";

function blocksOf(html: string): Element[] {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  const root = doc.getElementById("r");
  return root ? Array.from(root.children) : [];
}

function Chapter({ item }: { item: ReaderItem }) {
  // Interleave translated block + (muted) original. The EPUB and model output are
  // untrusted, so the combined HTML is sanitized before it touches the DOM.
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
    <section className="border-b border-border pb-8 last:border-none" dangerouslySetInnerHTML={{ __html: html }} />
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
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasOriginal && (
          <Button
            variant="outline"
            size="sm"
            aria-pressed={showOriginal}
            onClick={() => setShowOriginal((v) => !v)}
          >
            {showOriginal ? <EyeOff /> : <Eye />}
            {showOriginal ? "Eredeti elrejtése" : "Eredeti megjelenítése"}
          </Button>
        )}
        <a href={downloadHref} download className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          <Download />
          Letöltés (EPUB)
        </a>
      </div>

      <article
        className={cn(
          "rounded-[calc(var(--radius)+0.3rem)] border border-border bg-card prose-reader p-6 sm:p-10",
          !showOriginal && "hide-original",
        )}
      >
        {items.map((item) => (
          <Chapter key={item.href} item={item} />
        ))}
      </article>
    </section>
  );
}
