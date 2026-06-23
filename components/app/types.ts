export interface JobState {
  id: string;
  status: "pending" | "running" | "done" | "error" | "stopped";
  provider: string;
  title?: string;
  words: number;
  spineItemCount: number;
  chunks: { total: number; done: number };
  cost: { usd: number; ceilingUsd: number };
  error?: string;
}

/** A job plus whether it is actively running in the server process right now. */
export type JobSummary = JobState & { running: boolean };

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
}
