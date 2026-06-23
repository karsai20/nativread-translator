"use client";

import { ArrowUpRight } from "lucide-react";
import type { LibraryBook } from "./types";

interface LibraryProps {
  books: LibraryBook[];
  onOpen: (id: string) => void;
}

export function Library({ books, onOpen }: LibraryProps) {
  return (
    <section aria-labelledby="library-heading" className="rise">
      <p className="mb-3 text-[0.7rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        A műhely könyvtára
      </p>
      <h2 id="library-heading" className="display text-3xl font-semibold leading-tight sm:text-4xl">
        Eddig lefordítva
      </h2>

      {books.length === 0 ? (
        <p className="mt-7 rounded-[var(--radius)] border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">
          Még üres. Az első lefordított könyv ide kerül, és nem kell újrafordítani.
        </p>
      ) : (
        <ol className="mt-6">
          {books.map((b, i) => (
            <li key={b.id}>
              <button
                onClick={() => onOpen(b.id)}
                className="group flex w-full items-center gap-4 border-b border-border py-4 text-left transition-colors hover:border-primary"
              >
                <span className="tnum display w-7 shrink-0 text-sm text-muted-foreground transition-colors group-hover:text-primary">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium leading-snug transition-colors group-hover:text-primary">
                    {b.title}
                  </span>
                  <span className="mt-0.5 block text-xs uppercase tracking-[0.12em] text-muted-foreground">
                    {b.words.toLocaleString("hu-HU")} szó · {new Date(b.createdAt).toLocaleDateString("hu-HU")}
                  </span>
                </span>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-all -translate-x-1 group-hover:translate-x-0 group-hover:text-primary group-hover:opacity-100" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
