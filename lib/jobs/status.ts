// Shared, framework-free helpers for reasoning about job status. Used by hooks and
// presentational components alike.

import type { JobState, JobStatus } from "@/lib/core/job";

/** A job the engine is (or should be) actively working through. */
export function isActiveStatus(status: JobStatus): boolean {
  return status === "running" || status === "pending";
}

/** A job that still belongs on the dashboard's "in progress / needs attention" list. */
export function isOpenJob(job: JobState): boolean {
  return job.status !== "done";
}

export interface StatusMeta {
  label: string;
  /** Token-driven tone used for badges and the status dot. */
  tone: "running" | "paused" | "good" | "destructive" | "muted";
}

const STATUS_META: Record<JobStatus, StatusMeta> = {
  pending: { label: "Sorban", tone: "muted" },
  running: { label: "Fordítás", tone: "running" },
  paused: { label: "Szüneteltetve", tone: "paused" },
  done: { label: "Kész", tone: "good" },
  error: { label: "Hiba", tone: "destructive" },
  cancelled: { label: "Megszakítva", tone: "destructive" },
};

export function statusMeta(status: JobStatus): StatusMeta {
  return STATUS_META[status] ?? { label: status, tone: "muted" };
}
