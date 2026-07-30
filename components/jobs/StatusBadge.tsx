import * as React from "react";
import { cn } from "@/lib/utils";
import { statusMeta, type StatusMeta } from "@/lib/jobs/status";
import type { JobStatus } from "@/lib/jobs/types";

const TONE_CLASSES: Record<StatusMeta["tone"], { wrap: string; dot: string }> = {
  running: { wrap: "bg-accent text-accent-foreground", dot: "bg-primary" },
  paused: { wrap: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  good: { wrap: "bg-good/12 text-good", dot: "bg-good" },
  destructive: { wrap: "bg-destructive/12 text-destructive", dot: "bg-destructive" },
  muted: { wrap: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
};

export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const meta = statusMeta(status);
  const tone = TONE_CLASSES[meta.tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone.wrap,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}
