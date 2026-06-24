"use client";

import * as React from "react";
import { Clock, Gauge, FileText, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "./StatusBadge";
import { CostMeter } from "./CostMeter";
import { JobControls } from "./JobControls";
import { jobMetrics } from "@/lib/core/eta";
import { formatEta, formatSpeed, formatRelative, formatWords } from "@/lib/jobs/format";
import type { JobState } from "@/lib/jobs/types";

interface JobCardProps {
  job: JobState;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}

function Metric({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Icon className="size-3.5" />
      <span className="tnum text-foreground">{children}</span>
    </span>
  );
}

export function JobCard({ job, onPause, onResume, onCancel, onDelete }: JobCardProps) {
  const { pct, etaMs, chunksPerMin } = jobMetrics(job);
  const title = job.title ?? "Névtelen könyv";
  const eta = job.status === "running" ? formatEta(etaMs) : undefined;
  const speed = job.status === "running" ? formatSpeed(chunksPerMin) : undefined;
  const updated = formatRelative(job.updatedAt);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <h3 className="font-serif text-lg font-semibold leading-tight line-clamp-2 break-words" title={title}>
            {title}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={job.status} />
            <span className="capitalize">{job.provider}</span>
            {updated && <span>· frissítve {updated}</span>}
          </div>
        </div>
        <JobControls
          id={job.id}
          status={job.status}
          title={title}
          onPause={onPause}
          onResume={onResume}
          onCancel={onCancel}
          onDelete={onDelete}
        />
      </div>

      {job.status === "error" && job.error && (
        <p className="mt-4 flex items-start gap-2 rounded-[var(--radius)] bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{job.error}</span>
        </p>
      )}

      <div className="mt-4 space-y-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">{Math.round(pct)}%</span>
          <span className="tnum text-xs text-muted-foreground">
            {job.chunks.done}/{job.chunks.total} szakasz
          </span>
        </div>
        <Progress value={pct} className="h-2" />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <CostMeter cost={job.cost} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs sm:justify-end">
          {job.words > 0 && <Metric icon={FileText}>{formatWords(job.words)} szó</Metric>}
          {speed && <Metric icon={Gauge}>{speed}</Metric>}
          {eta && <Metric icon={Clock}>{eta}</Metric>}
        </div>
      </div>
    </Card>
  );
}
