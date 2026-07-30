"use client";

import * as React from "react";
import { DashboardHeader } from "@/components/shell/DashboardHeader";
import { LibraryTable } from "@/components/library/LibraryTable";
import { UploadDialog } from "@/components/dashboard/UploadDialog";
import { useLibrary } from "@/lib/jobs/use-library";

export default function LibraryPage() {
  const { books, remove, refresh } = useLibrary();

  return (
    <>
      <DashboardHeader
        title="Könyvtár"
        subtitle={`${books.length} lefordított kötet`}
        action={<UploadDialog onStarted={refresh} />}
      />

      <main className="mx-auto w-full max-w-6xl px-5 py-6 sm:px-8">
        <LibraryTable books={books} onDelete={remove} />
      </main>
    </>
  );
}
