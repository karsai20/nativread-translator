"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { JobCard } from "@/components/jobs/JobCard";
import { EmptyState } from "./EmptyState";
import { isOpenJob } from "@/lib/jobs/status";
import type { UseJobs } from "@/lib/jobs/use-jobs";

export function ActiveJobs({ jobs, pause, resume, cancel, remove }: UseJobs) {
  const open = jobs.filter(isOpenJob);

  if (open.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Nincs folyamatban lévő fordítás"
        description="Tölts fel egy EPUB-ot az „Új könyv” gombbal, és itt élőben követheted az állapotát."
      />
    );
  }

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {open.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onPause={pause}
          onResume={resume}
          onCancel={cancel}
          onDelete={remove}
        />
      ))}
    </div>
  );
}
