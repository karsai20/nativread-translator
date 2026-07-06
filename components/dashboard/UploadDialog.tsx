"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, UploadCloud, BookOpen, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PrecisionMode = "balanced" | "fidelity" | "natural";

interface ServerConfig {
  provider: string;
  model?: string;
  apiConfigured: boolean;
  precision: PrecisionMode;
  recommendedProvider: string;
  recommendedModel: string;
}

const precisionOptions: Array<{
  value: PrecisionMode;
  label: string;
  description: string;
}> = [
  {
    value: "balanced",
    label: "Kiegyensúlyozott",
    description: "Alap mód a legtöbb könyvhöz.",
  },
  {
    value: "fidelity",
    label: "Hűség",
    description: "Szigorúbb kihagyás- és jelentésellenőrzés.",
  },
  {
    value: "natural",
    label: "Természetes",
    description: "Magyarosabb, kevésbé szó szerinti hang.",
  },
];

interface UploadDialogProps {
  /** Called after a translation has been queued, so the dashboard can refresh. */
  onStarted?: () => void;
}

export function UploadDialog({ onStarted }: UploadDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [sample, setSample] = React.useState(false);
  const [precision, setPrecision] = React.useState<PrecisionMode>("balanced");
  const [config, setConfig] = React.useState<ServerConfig | null>(null);

  React.useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: ServerConfig) => {
        setConfig(d);
        setPrecision(d.precision ?? "balanced");
      })
      .catch(() => {});
  }, []);

  const reset = () => {
    setFile(null);
    setDrag(false);
    setBusy(false);
    setSample(false);
    setPrecision(config?.precision ?? "balanced");
  };

  const start = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("epub", file);
      const up = await fetch("/api/upload", { method: "POST", body: form });
      const uj = (await up.json()) as { id: string; alreadyTranslated?: boolean; error?: string };
      if (!up.ok) throw new Error(uj.error ?? "A feltöltés nem sikerült.");

      if (uj.alreadyTranslated) {
        setOpen(false);
        router.push(`/read/${encodeURIComponent(uj.id)}`);
        return;
      }

      const tr = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: uj.id, sample, precision }),
      });
      if (!tr.ok) throw new Error(((await tr.json()) as { error?: string }).error ?? "A fordítás nem indult el.");

      toast.success(sample ? "A próbafordítás (első 5%) elindult." : "A fordítás elindult.");
      setOpen(false);
      reset();
      onStarted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Hiba történt.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Új könyv
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Új könyv fordítása</DialogTitle>
          <DialogDescription>
            Válassz egy EPUB-ot. A fordítás a háttérben fut, az állapotát az áttekintésen követheted.
          </DialogDescription>
        </DialogHeader>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
          className={cn(
            // min-w-0: the dialog is a CSS grid, whose items default to min-width:auto and
            // won't shrink — without this a long file name overflows the dialog instead of
            // letting the inner truncate engage.
            "flex min-w-0 cursor-pointer items-center gap-4 rounded-[var(--radius)] border border-dashed border-border bg-surface px-5 py-6 transition-colors hover:border-primary",
            drag && "border-primary bg-accent/40",
            file && "border-good/70",
          )}
        >
          <input
            type="file"
            // iOS/Android file pickers grey out .epub when accept is too narrow, and cloud
            // sources often report epub as octet-stream/zip — keep it broad so phones can
            // actually pick the book. The server validates that it is a real EPUB anyway.
            accept=".epub,application/epub+zip,application/octet-stream,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
            }}
          />
          <span
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground",
              file && "bg-good/15 text-good",
            )}
          >
            {file ? <BookOpen className="size-5" /> : <UploadCloud className="size-5" />}
          </span>
          <span className="min-w-0">
            <span className={cn("block font-medium", file && "truncate")}>
              {file ? file.name : "Koppints egy EPUB kiválasztásához"}
            </span>
            <span className="block text-sm text-muted-foreground">
              {file ? "Készen áll a fordításra" : "Telefonról is — EPUB formátum, bármilyen méret"}
            </span>
          </span>
        </label>

        <button
          type="button"
          role="checkbox"
          aria-checked={sample}
          onClick={() => setSample((s) => !s)}
          disabled={busy}
          className={cn(
            "flex w-full min-w-0 items-start gap-3 rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary disabled:opacity-60",
            sample && "border-primary bg-accent/40",
          )}
        >
          <span
            className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-[6px] border border-border text-primary-foreground transition-colors",
              sample ? "border-primary bg-primary" : "bg-surface",
            )}
          >
            {sample ? <span className="text-xs leading-none">✓</span> : null}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">Csak az első 5% (próbafordítás)</span>
            <span className="block text-sm text-muted-foreground">
              Olcsó minta a minőség ellenőrzéséhez, mielőtt az egész könyvet lefordítanád. A többi rész eredeti nyelven marad.
            </span>
          </span>
        </button>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Minőségi mód</span>
            {config && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {config.provider}/{config.model ?? "nincs modell"}
              </span>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {precisionOptions.map((option) => {
              const active = precision === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPrecision(option.value)}
                  disabled={busy}
                  className={cn(
                    "min-w-0 rounded-[var(--radius)] border border-border bg-surface px-3 py-3 text-left transition-colors hover:border-primary disabled:opacity-60",
                    active && "border-primary bg-accent/40",
                  )}
                >
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {config && !config.apiConfigured && (
          <p className="rounded-[var(--radius)] border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            Nincs API kulcs beállítva, ezért a szerver fake módban fut.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Mégse
          </Button>
          <Button size="sm" disabled={!file || busy} onClick={start}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? "Indítás…" : sample ? "Próbafordítás indítása" : "Fordítás indítása"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
