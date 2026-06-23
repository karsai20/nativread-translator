"use client";

import type { LibraryBook } from "./types";

/** The "stats", as a typographic colophon line — like a literary journal's masthead,
 *  not a grid of dashboard tiles. */
export function Colophon({ books, provider }: { books: LibraryBook[]; provider: string }) {
  const volumes = books.length;
  const words = books.reduce((n, b) => n + (b.words || 0), 0);
  const cost = books.reduce((n, b) => n + (b.costUsd || 0), 0);
  const live = provider === "deepseek";

  return (
    <dl className="flex flex-wrap items-center gap-x-5 gap-y-3 text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">
      <Item label="Kötet" value={volumes.toLocaleString("hu-HU")} />
      <Sep />
      <Item label="Szó lefordítva" value={words.toLocaleString("hu-HU")} />
      <Sep />
      <Item label="Összesen" value={`$${cost.toFixed(2)}`} />
      <Sep />
      <div className="flex items-center gap-2">
        <span
          className={`size-1.5 rounded-full ${live ? "live-dot bg-good" : "bg-muted-foreground/50"}`}
          aria-hidden
        />
        <span className="text-foreground">{live ? "DeepSeek" : "Teszt"}</span>
        <span>motor</span>
      </div>
    </dl>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dd className="tnum display text-base font-semibold tracking-normal text-foreground">{value}</dd>
      <dt>{label}</dt>
    </div>
  );
}

function Sep() {
  return <span aria-hidden className="size-1 rounded-full bg-border" />;
}
