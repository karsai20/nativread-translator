"use client";

import * as React from "react";
import { Server, Coins, Sparkles, Sun } from "lucide-react";
import { DashboardHeader } from "@/components/shell/DashboardHeader";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { formatUsd } from "@/lib/jobs/format";

interface ServerSettings {
  provider: string;
  costCeilingUsd: number;
  refine: boolean;
}

function Row({
  icon: Icon,
  label,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[var(--radius)] bg-muted text-muted-foreground">
          <Icon className="size-[1.05rem]" />
        </span>
        <div className="min-w-0">
          <p className="font-medium">{label}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = React.useState<ServerSettings | null>(null);

  React.useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: ServerSettings) => setSettings(d))
      .catch(() => {});
  }, []);

  const value = "tnum text-sm font-medium";

  return (
    <>
      <DashboardHeader title="Beállítások" subtitle="A műhely aktuális konfigurációja" />

      <main className="mx-auto w-full max-w-2xl px-5 py-6 sm:px-8">
        <div className="divide-y divide-border overflow-hidden rounded-[calc(var(--radius)+0.2rem)] border border-border bg-card">
          <Row icon={Server} label="Fordítószolgáltató" description="A háttérben dolgozó motor (környezeti változó).">
            <span className={`${value} capitalize`}>{settings?.provider ?? "…"}</span>
          </Row>
          <Row icon={Coins} label="Költségplafon" description="Könyvenkénti felső határ, amelyen a fordítás leáll.">
            <span className={value}>{settings ? formatUsd(settings.costCeilingUsd) : "…"}</span>
          </Row>
          <Row icon={Sparkles} label="Csiszoló kör" description="Második, minőségjavító fordítási menet.">
            <span className={value}>{settings ? (settings.refine ? "Bekapcsolva" : "Kikapcsolva") : "…"}</span>
          </Row>
          <Row icon={Sun} label="Megjelenés" description="Világos vagy sötét téma ezen a gépen.">
            <ThemeToggle />
          </Row>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          A szolgáltató, a plafon és a csiszoló kör a szerver környezeti változóiból jön
          (PROVIDER_API_KEY, COST_CEILING_USD, TRANSLATION_REFINE).
        </p>
      </main>
    </>
  );
}
