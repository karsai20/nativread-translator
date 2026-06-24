"use client";

import * as React from "react";
import { toast } from "sonner";
import type { JobState, JobStatus } from "@/lib/core/job";
import { isActiveStatus } from "./status";

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "A művelet nem sikerült.";
}

export interface UseJobs {
  jobs: JobState[];
  loading: boolean;
  refresh: () => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string, withLibrary?: boolean) => Promise<void>;
}

/** Polls every job, faster while work is active, with optimistic control actions. */
export function useJobs(): UseJobs {
  const [jobs, setJobs] = React.useState<JobState[]>([]);
  const [loading, setLoading] = React.useState(true);
  const latest = React.useRef<JobState[]>([]);
  latest.current = jobs;

  const fetchJobs = React.useCallback(async (): Promise<JobState[]> => {
    const res = await fetch("/api/jobs");
    const data = (await res.json()) as { jobs?: JobState[] };
    const next = data.jobs ?? [];
    setJobs(next);
    return next;
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      await fetchJobs();
    } catch {
      /* transient — next tick retries */
    }
  }, [fetchJobs]);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      let next: JobState[] = [];
      try {
        next = await fetchJobs();
      } catch {
        next = latest.current;
      } finally {
        setLoading(false);
      }
      if (cancelled) return;
      const delay = next.some((j) => isActiveStatus(j.status)) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(tick, delay);
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fetchJobs]);

  const mutate = React.useCallback(
    async (optimistic: (jobs: JobState[]) => JobState[], run: () => Promise<Response>) => {
      const snapshot = latest.current;
      setJobs(optimistic);
      try {
        const res = await run();
        if (!res.ok) throw new Error(await errorOf(res));
        await fetchJobs();
      } catch (err) {
        setJobs(snapshot);
        toast.error(err instanceof Error ? err.message : "A művelet nem sikerült.");
      }
    },
    [fetchJobs],
  );

  const setStatus = (id: string, status: JobStatus) => (list: JobState[]) =>
    list.map((j) => (j.id === id ? { ...j, status } : j));

  const pause = React.useCallback(
    (id: string) => mutate(setStatus(id, "paused"), () => postJson("/api/job/pause", { id })),
    [mutate],
  );
  const resume = React.useCallback(
    (id: string) => mutate(setStatus(id, "running"), () => postJson("/api/job/resume", { id })),
    [mutate],
  );
  const cancel = React.useCallback(
    (id: string) => mutate(setStatus(id, "cancelled"), () => postJson("/api/job/cancel", { id })),
    [mutate],
  );
  const remove = React.useCallback(
    (id: string, withLibrary = false) =>
      mutate(
        (list) => list.filter((j) => j.id !== id),
        () =>
          fetch(`/api/job?id=${encodeURIComponent(id)}${withLibrary ? "&withLibrary=1" : ""}`, {
            method: "DELETE",
          }),
      ),
    [mutate],
  );

  return { jobs, loading, refresh, pause, resume, cancel, remove };
}
