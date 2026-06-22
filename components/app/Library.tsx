"use client";

import { Library as LibraryIcon, BookText } from "lucide-react";
import type { LibraryBook } from "./types";

interface LibraryProps {
  books: LibraryBook[];
  onOpen: (id: string) => void;
}

export function Library({ books, onOpen }: LibraryProps) {
  if (books.length === 0) return null;

  return (
    <section aria-labelledby="library-heading" className="space-y-4">
      <h2 id="library-heading" className="flex items-center gap-2 font-serif text-2xl">
        <LibraryIcon className="size-5 text-primary" />
        Házi könyvtár
      </h2>
      <p className="text-sm text-muted-foreground">
        Korábban lefordított könyvek — nem kell újrafordítani.
      </p>

      <ul className="grid gap-3 sm:grid-cols-2">
        {books.map((b) => (
          <li key={b.id}>
            <button
              onClick={() => onOpen(b.id)}
              className="group flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-[0_14px_40px_-30px_var(--color-primary)]"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
                <BookText className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{b.title}</span>
                <span className="block text-sm text-muted-foreground">
                  {b.words.toLocaleString("hu-HU")} szó · {new Date(b.createdAt).toLocaleDateString("hu-HU")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
