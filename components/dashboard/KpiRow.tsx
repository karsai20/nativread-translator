import * as React from "react";
import { Library, Loader2, Coins, FileText } from "lucide-react";
import { StatCard } from "./StatCard";
import { isActiveStatus } from "@/lib/jobs/status";
import { formatUsd, formatWords } from "@/lib/jobs/format";
import type { JobState, LibraryBook } from "@/lib/jobs/types";

interface KpiRowProps {
  jobs: JobState[];
  books: LibraryBook[];
}

export function KpiRow({ jobs, books }: KpiRowProps) {
  const activeCount = jobs.filter((j) => isActiveStatus(j.status)).length;
  const librarySpend = books.reduce((sum, b) => sum + b.costUsd, 0);
  const activeSpend = jobs
    .filter((j) => j.status !== "done")
    .reduce((sum, j) => sum + j.cost.usd, 0);
  const libraryWords = books.reduce((sum, b) => sum + b.words, 0);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Könyvtár" value={String(books.length)} hint="lefordított kötet" icon={Library} />
      <StatCard
        label="Folyamatban"
        value={String(activeCount)}
        hint={activeCount ? "aktív fordítás" : "nincs aktív munka"}
        icon={Loader2}
      />
      <StatCard
        label="Összköltség"
        value={formatUsd(librarySpend + activeSpend)}
        hint={`könyvtár ${formatUsd(librarySpend)}`}
        icon={Coins}
      />
      <StatCard label="Lefordított szó" value={formatWords(libraryWords)} hint="a könyvtárban" icon={FileText} />
    </div>
  );
}
