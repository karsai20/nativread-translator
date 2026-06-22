export interface JobState {
  id: string;
  status: "pending" | "running" | "done" | "error";
  provider: string;
  title?: string;
  words: number;
  spineItemCount: number;
  chunks: { total: number; done: number };
  cost: { usd: number; ceilingUsd: number };
  error?: string;
}

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
