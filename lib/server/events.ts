// T18 funnel events (eng D12): metadata-only JSONL, no third-party analytics.
// The failure buckets are the kill-signal denominator — a DRM-heavy or
// import-broken cohort must not masquerade as a pricing/wedge failure.
// One line per event; the dashboard is a grep/count over this file.

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ServerConfig } from "./config";

export type FunnelEventType =
  | "import-failed"
  | "moderation-refused"
  | "waitlist-joined";

export interface FunnelEvent {
  type: FunnelEventType;
  /** Raw user id; stored as a sha256 so the log stays pseudonymous. */
  userId?: string;
  jobId?: string;
  language?: string;
  /** Short free-text detail (e.g. parse error class). Keep it metadata-only. */
  detail?: string;
}

export function eventsPath(config: ServerConfig): string {
  return join(config.jobsDir, "events.jsonl");
}

export function appendEvent(config: ServerConfig, event: FunnelEvent): void {
  try {
    mkdirSync(config.jobsDir, { recursive: true });
    const { userId, ...rest } = event;
    appendFileSync(
      eventsPath(config),
      JSON.stringify({
        ts: new Date().toISOString(),
        ...rest,
        ...(userId
          ? { user: createHash("sha256").update(userId).digest("hex").slice(0, 16) }
          : {}),
      }) + "\n",
    );
  } catch {
    // Events are observability, never a failure path.
  }
}
