"use client";

import * as React from "react";
import { DashboardHeader } from "@/components/shell/DashboardHeader";
import { KpiRow } from "@/components/dashboard/KpiRow";
import { ActiveJobs } from "@/components/dashboard/ActiveJobs";
import { UploadDialog } from "@/components/dashboard/UploadDialog";
import { useJobs } from "@/lib/jobs/use-jobs";
import { useLibrary } from "@/lib/jobs/use-library";

export default function OverviewPage() {
  const jobsState = useJobs();
  const { books } = useLibrary();

  return (
    <>
      <DashboardHeader
        title="Áttekintés"
        subtitle="A NativRead Web élő állapota"
        action={<UploadDialog onStarted={jobsState.refresh} />}
      />

      <main className="mx-auto w-full max-w-6xl space-y-8 px-5 py-6 sm:px-8">
        <KpiRow jobs={jobsState.jobs} books={books} />

        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Folyamatban
          </h2>
          <ActiveJobs {...jobsState} />
        </section>
      </main>
    </>
  );
}
