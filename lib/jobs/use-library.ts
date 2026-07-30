"use client";

import * as React from "react";
import { toast } from "sonner";
import type { LibraryBook } from "./types";

export interface UseLibrary {
  books: LibraryBook[];
  loading: boolean;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useLibrary(): UseLibrary {
  const [books, setBooks] = React.useState<LibraryBook[]>([]);
  const [loading, setLoading] = React.useState(true);
  const latest = React.useRef<LibraryBook[]>([]);
  latest.current = books;

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/library");
      const data = (await res.json()) as { books?: LibraryBook[] };
      setBooks(data.books ?? []);
    } catch {
      /* library is best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = React.useCallback(
    async (id: string) => {
      const snapshot = latest.current;
      setBooks((list) => list.filter((b) => b.id !== id));
      try {
        const res = await fetch(`/api/job?id=${encodeURIComponent(id)}&withLibrary=1`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error("A törlés nem sikerült.");
      } catch (err) {
        setBooks(snapshot);
        toast.error(err instanceof Error ? err.message : "A törlés nem sikerült.");
      }
    },
    [],
  );

  return { books, loading, refresh, remove };
}
