"use client";

import * as React from "react";
import Link from "next/link";
import { MoreHorizontal, BookOpen, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import type { LibraryBook } from "@/lib/jobs/types";

interface LibraryRowActionsProps {
  book: LibraryBook;
  onDelete: (id: string) => void;
}

export function LibraryRowActions({ book, onDelete }: LibraryRowActionsProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Műveletek">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem asChild>
            <Link href={`/read/${encodeURIComponent(book.id)}`}>
              <BookOpen />
              Olvasás
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/api/result?id=${encodeURIComponent(book.id)}&download=1`} download>
              <Download />
              Letöltés (EPUB)
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={(e) => {
              e.preventDefault();
              setConfirmOpen(true);
            }}
          >
            <Trash2 />
            Törlés
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Törlöd a könyvtárból?</AlertDialogTitle>
            <AlertDialogDescription>
              A(z) „{book.title}” véglegesen törlődik a könyvtárból. Ez nem visszavonható.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Mégse</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDelete(book.id)}>Törlés</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
