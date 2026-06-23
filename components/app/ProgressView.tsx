"use client";

import { Progress } from "@/components/ui/progress";
import type { JobState } from "./types";

export function ProgressView({ state }: { state: JobState | null }) {
  const total = state?.chunks.total ?? 0;
  const done = state?.chunks.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 4;

  return (
    <section aria-labelledby="progress-heading" className="space-y-6 rise">
      <div className="space-y-2">
        <p className="flex items-center gap-3 text-[0.7rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary live-dot" />
          Folyamatban
        </p>
        <h1 id="progress-heading" className="display text-3xl font-semibold sm:text-4xl">
          Készül a magyar kiadás…
        </h1>
        <p className="text-muted-foreground">
          {state?.title ? `„${state.title}” — ` : ""}
          {total > 0 ? `fejezetrészek fordítása (${pct}%)` : "könyv feldolgozása…"}
        </p>
      </div>

      <Progress value={pct} />

      <dl className="flex flex-wrap gap-x-12 gap-y-4">
        <Stat label="Kész részek" value={`${done} / ${total}`} />
        <Stat label="Becsült költség" value={`$${(state?.cost.usd ?? 0).toFixed(2)}`} />
        {state?.words ? <Stat label="Szavak" value={state.words.toLocaleString("hu-HU")} /> : null}
      </dl>

      <p className="max-w-prose text-sm text-muted-foreground">
        Nyugodtan bezárhatod ezt az ablakot — az elkészült részek megmaradnak, és a
        fordítás onnan folytatódik, ahol abbamaradt.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1 display text-2xl font-semibold tnum">{value}</dd>
    </div>
  );
}
