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

  const reset = () => {
    setFile(null);
    setDrag(false);
    setBusy(false);
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
        body: JSON.stringify({ id: uj.id }),
      });
      if (!tr.ok) throw new Error(((await tr.json()) as { error?: string }).error ?? "A fordítás nem indult el.");

      toast.success("A fordítás elindult.");
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
            "flex cursor-pointer items-center gap-4 rounded-[var(--radius)] border border-dashed border-border bg-surface px-5 py-6 transition-colors hover:border-primary",
            drag && "border-primary bg-accent/40",
            file && "border-good/70",
          )}
        >
          <input
            type="file"
            accept=".epub,application/epub+zip"
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
            <span className="block truncate font-medium">
              {file ? file.name : "Válassz vagy húzz ide egy EPUB-ot"}
            </span>
            <span className="block text-sm text-muted-foreground">
              {file ? "Készen áll a fordításra" : "EPUB formátum, bármilyen méret"}
            </span>
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Mégse
          </Button>
          <Button size="sm" disabled={!file || busy} onClick={start}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? "Indítás…" : "Fordítás indítása"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
