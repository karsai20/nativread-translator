"use client";

import { Progress } from "@/components/ui/progress";
import type { JobState } from "./types";

export function ProgressView({ state }: { state: JobState | null }) {
  const total = state?.chunks.total ?? 0;
  const done = state?.chunks.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 4;

  return (
    <section aria-labelledby="progress-heading" className="space-y-6">
      <div className="space-y-2">
        <h1 id="progress-heading" className="font-serif text-3xl sm:text-4xl">
          Fordítás folyamatban…
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
      <dd className="mt-1 font-serif text-2xl">{value}</dd>
    </div>
  );
}
