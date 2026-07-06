"use client";

import * as React from "react";
import { Server, Coins, Sparkles, Sun, Cpu, KeyRound, Route, Gauge, Boxes, CheckCircle2 } from "lucide-react";
import { DashboardHeader } from "@/components/shell/DashboardHeader";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { formatUsd } from "@/lib/jobs/format";

interface ServerSettings {
  provider: string;
  model?: string;
  apiConfigured: boolean;
  costCeilingUsd: number;
  refine: boolean;
  refineSelective: boolean;
  reasonerForHard: boolean;
  reasonerModel?: string;
  precision: "balanced" | "fidelity" | "natural";
  concurrency: number;
  recommendedProvider: string;
  recommendedModel: string;
  appProfile: string;
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
      <div className="shrink-0 text-right">{children}</div>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn";
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        tone === "good"
          ? "border-good/30 bg-good/10 text-good"
          : tone === "warn"
            ? "border-amber-400/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
            : "border-border bg-muted text-muted-foreground",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function precisionLabel(value?: ServerSettings["precision"]): string {
  if (value === "fidelity") return "Hűség";
  if (value === "natural") return "Természetes";
  return "Kiegyensúlyozott";
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
          <Row icon={Cpu} label="Modell" description="A fordításhoz konfigurált modell.">
            <span className={value}>{settings?.model ?? "…"}</span>
          </Row>
          <Row icon={KeyRound} label="API kulcs" description="A szerver env-ből olvasott provider kulcs állapota.">
            {settings ? (
              <Pill tone={settings.apiConfigured ? "good" : "warn"}>
                {settings.apiConfigured ? "Beállítva" : "Fake mód"}
              </Pill>
            ) : (
              <span className={value}>…</span>
            )}
          </Row>
          <Row icon={Coins} label="Költségplafon" description="Könyvenkénti felső határ, amelyen a fordítás leáll.">
            <span className={value}>{settings ? formatUsd(settings.costCeilingUsd) : "…"}</span>
          </Row>
          <Row icon={Sparkles} label="Csiszoló kör" description="Második, minőségjavító fordítási menet.">
            <span className={value}>{settings ? (settings.refine ? "Bekapcsolva" : "Kikapcsolva") : "…"}</span>
          </Row>
          <Row icon={Route} label="Minőségi routing" description="Gyenge szakaszok szelektív javítása és eszkalációja.">
            <span className={value}>
              {settings
                ? `${precisionLabel(settings.precision)} · ${settings.refineSelective ? "szelektív" : "minden szakasz"}`
                : "…"}
            </span>
          </Row>
          <Row icon={Gauge} label="Párhuzamosság" description="Egyszerre futó fordítási szakaszok száma.">
            <span className={value}>{settings ? `${settings.concurrency} worker` : "…"}</span>
          </Row>
          <Row icon={Boxes} label="Runtime profil" description="Webes műhely vagy NativRead mobil backend konténer.">
            <span className={`${value} uppercase`}>{settings?.appProfile ?? "…"}</span>
          </Row>
          <Row icon={CheckCircle2} label="Ajánlott MVP modell" description="Az alap cost/quality választás könyvfordításhoz.">
            <span className={value}>
              {settings ? `${settings.recommendedProvider}/${settings.recommendedModel}` : "…"}
            </span>
          </Row>
          <Row icon={Sun} label="Megjelenés" description="Világos vagy sötét téma ezen a gépen.">
            <ThemeToggle />
          </Row>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          A szolgáltató, a plafon és az alap minőségi mód szerver környezeti változókból jön.
          Feltöltéskor a GUI-ból könyvenként felülírható a minőségi mód.
        </p>
      </main>
    </>
  );
}
