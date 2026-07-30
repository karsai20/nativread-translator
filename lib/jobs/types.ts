// Client-facing job/library types. JobState/JobStatus are re-exported from the core
// (type-only, so no node dependency reaches the browser bundle).

export type { JobState, JobStatus } from "@/lib/core/job";

export interface ReaderItem {
  href: string;
  title: string;
  originalHtml: string;
  translatedHtml: string;
}

export interface LibraryBook {
  id: string;
  title: string;
  words: number;
  costUsd: number;
  createdAt: string;
  /** True for a first-content-chapter preview translation. */
  sample?: boolean;
}
