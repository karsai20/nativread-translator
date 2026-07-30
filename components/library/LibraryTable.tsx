"use client";

import * as React from "react";
import Link from "next/link";
import { Library as LibraryIcon } from "lucide-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { LibraryRowActions } from "./LibraryRowActions";
import { formatUsd, formatWords, formatDate } from "@/lib/jobs/format";
import type { LibraryBook } from "@/lib/jobs/types";

interface LibraryTableProps {
  books: LibraryBook[];
  onDelete: (id: string) => void;
}

export function LibraryTable({ books, onDelete }: LibraryTableProps) {
  if (books.length === 0) {
    return (
      <EmptyState
        icon={LibraryIcon}
        title="A könyvtár még üres"
        description="Az elkészült fordítások ide kerülnek, és bármikor újraolvashatók vagy letölthetők."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-[calc(var(--radius)+0.2rem)] border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Cím</TableHead>
            <TableHead className="text-right">Szó</TableHead>
            <TableHead className="text-right">Költség</TableHead>
            <TableHead>Dátum</TableHead>
            <TableHead className="w-12 text-right">·</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {books.map((book) => (
            <TableRow key={book.id}>
              <TableCell className="max-w-[22rem]">
                <Link
                  href={`/read/${encodeURIComponent(book.id)}`}
                  className="flex items-center gap-2 font-serif font-medium hover:text-primary"
                >
                  <span className="truncate">{book.title}</span>
                  {book.sample && (
                    <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground" title="Az első tartalmi fejezet lett lefordítva">
                      Fejezetpróba
                    </span>
                  )}
                </Link>
              </TableCell>
              <TableCell className="tnum text-right text-muted-foreground">{formatWords(book.words)}</TableCell>
              <TableCell className="tnum text-right text-muted-foreground">{formatUsd(book.costUsd)}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(book.createdAt)}</TableCell>
              <TableCell className="text-right">
                <LibraryRowActions book={book} onDelete={onDelete} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
