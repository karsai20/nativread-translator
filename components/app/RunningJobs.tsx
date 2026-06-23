"use client";

import * as React from "react";
import { Activity, Loader2, Square, Play, Trash2, AlertTriangle, PauseCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { JobSummary } from "./types";

const POLL_MS = 1500;

interface RunningJobsProps {
  /** Called after a job is stopped/discarded/resumed, so the library can refresh too. */
  onChange?: () => void;
}

export function RunningJobs({ onChange }: RunningJobsProps) {
  const [jobs, setJobs] = React.useState<JobSummary[]>([]);
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } catch {
      /* polling is best-effort */
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      await refresh();
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    let timer: ReturnType<typeof setTimeout>;
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  const act = async (id: string, path: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
      await refresh();
      onChange?.();
    }
  };

  const discard = async (id: string, title?: string) => {
    if (!confirm(`Biztosan elveted ezt a fordítást? Az eddigi részek is törlődnek.\n\n${title ?? id}`)) {
      return;
    }
    await act(id, "/api/discard");
  };

  if (jobs.length === 0) return null;

  return (
    <section aria-labelledby="jobs-heading" className="space-y-4">
      <h2 id="jobs-heading" className="flex items-center gap-2 font-serif text-2xl">
        <Activity className="size-5 text-primary" />
        Futó fordítások
      </h2>
      <p className="text-sm text-muted-foreground">
        Folyamatban lévő fordítások — itt leállíthatod, folytathatod vagy elvetheted őket.
      </p>

      <ul className="space-y-3">
        {jobs.map((job) => {
          const total = job.chunks.total || 0;
          const done = job.chunks.done || 0;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const isBusy = !!busy[job.id];

          return (
            <li
              key={job.id}
              className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{job.title ?? "Névtelen könyv"}</span>
                  <span className="block text-sm text-muted-foreground">
                    {done} / {total} rész · ${job.cost.usd.toFixed(2)}
                  </span>
                </span>
                <StatusBadge job={job} />
              </div>

              <Progress value={pct} />

              {job.status === "error" && job.error ? (
                <p className="text-sm text-[oklch(55%_0.16_28)]">{job.error}</p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {job.running ? (
                  <Button size="sm" variant="subtle" disabled={isBusy} onClick={() => act(job.id, "/api/stop")}>
                    <Square className="size-4" /> Leállítás
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => act(job.id, "/api/translate")}>
                    <Play className="size-4" /> Folytatás
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  className="text-[oklch(55%_0.16_28)] hover:border-[oklch(55%_0.16_28)]"
                  onClick={() => discard(job.id, job.title)}
                >
                  <Trash2 className="size-4" /> Elvetés
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatusBadge({ job }: { job: JobSummary }) {
  if (job.running) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-accent px-3 py-1 text-xs font-medium text-primary">
        <Loader2 className="size-3.5 animate-spin" /> Folyamatban
      </span>
    );
  }
  if (job.status === "error") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[oklch(55%_0.16_28)] px-3 py-1 text-xs font-medium text-[oklch(55%_0.16_28)]">
        <AlertTriangle className="size-3.5" /> Hiba
      </span>
    );
  }
  if (job.status === "stopped") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        <PauseCircle className="size-3.5" /> Leállítva
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
      Várakozik
    </span>
  );
}
