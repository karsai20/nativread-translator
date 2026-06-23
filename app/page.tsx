"use client";

import * as React from "react";
import { Uploader } from "@/components/app/Uploader";
import { ProgressView } from "@/components/app/ProgressView";
import { Reader } from "@/components/app/Reader";
import { Library } from "@/components/app/Library";
import { RunningJobs } from "@/components/app/RunningJobs";
import { Button } from "@/components/ui/button";
import type { JobState, ReaderItem, LibraryBook } from "@/components/app/types";

type View = "upload" | "progress" | "reader" | "error";
const POLL_MS = 1000;

export default function Home() {
  const [view, setView] = React.useState<View>("upload");
  const [provider, setProvider] = React.useState("fake");
  const [state, setState] = React.useState<JobState | null>(null);
  const [items, setItems] = React.useState<ReaderItem[]>([]);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [books, setBooks] = React.useState<LibraryBook[]>([]);

  const refreshLibrary = React.useCallback(async () => {
    try {
      const res = await fetch("/api/library");
      const data = await res.json();
      setBooks(data.books ?? []);
    } catch {
      /* library is best-effort */
    }
  }, []);

  React.useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const fail = (msg: string) => {
    setError(msg);
    setView("error");
  };

  const openReader = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/result?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Az eredmény nem tölthető be.");
      setJobId(id);
      setItems(data.items as ReaderItem[]);
      setView("reader");
    } catch (e) {
      fail((e as Error).message);
    }
  }, []);

  const poll = React.useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/status?id=${encodeURIComponent(id)}`);
        const s: JobState = await res.json();
        if (!res.ok) throw new Error((s as unknown as { error: string }).error);
        setState(s);
        if (s.status === "done") {
          await refreshLibrary();
          return openReader(id);
        }
        if (s.status === "error") return fail(s.error ?? "Hiba a fordítás közben.");
        setTimeout(() => poll(id), POLL_MS);
      } catch (e) {
        fail((e as Error).message);
      }
    },
    [openReader, refreshLibrary],
  );

  const start = async (file: File) => {
    try {
      setView("progress");
      setState(null);
      const form = new FormData();
      form.append("epub", file);
      const up = await fetch("/api/upload", { method: "POST", body: form });
      const uj = await up.json();
      if (!up.ok) throw new Error(uj.error ?? "Feltöltés sikertelen.");
      setProvider(uj.provider ?? provider);

      // Already in the household library — skip straight to reading.
      if (uj.alreadyTranslated) return openReader(uj.id);

      const tr = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: uj.id }),
      });
      if (!tr.ok) throw new Error((await tr.json()).error ?? "A fordítás nem indult el.");
      void poll(uj.id);
    } catch (e) {
      fail((e as Error).message);
    }
  };

  const reset = () => {
    setView("upload");
    setState(null);
    setItems([]);
    setError("");
    void refreshLibrary();
  };

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-5 pb-24 pt-10 sm:pt-16">
      <header className="mb-10 text-center">
        <div className="font-serif text-lg tracking-wide text-primary">Könyvfordító</div>
      </header>

      <main className="space-y-14">
        {view === "upload" && (
          <>
            <Uploader providerName={provider} onStart={start} />
            <RunningJobs onChange={refreshLibrary} />
            <Library books={books} onOpen={openReader} />
          </>
        )}

        {view === "progress" && <ProgressView state={state} />}

        {view === "reader" && jobId && (
          <>
            <Reader items={items} downloadHref={`/api/result?id=${encodeURIComponent(jobId)}&download=1`} />
            <div>
              <Button variant="ghost" onClick={reset}>
                Új könyv fordítása
              </Button>
            </div>
          </>
        )}

        {view === "error" && (
          <section className="space-y-4">
            <h1 className="font-serif text-3xl">Hiba történt</h1>
            <p className="rounded-[var(--radius)] bg-[oklch(94%_0.05_28)] p-4 text-[oklch(40%_0.14_28)]">
              {error}
            </p>
            <Button variant="ghost" onClick={reset}>
              Újrakezdés
            </Button>
          </section>
        )}
      </main>

      <footer className="mt-16 text-center text-sm text-muted-foreground">
        Helyi eszköz · házi hálózat · {provider === "deepseek" ? "DeepSeek fordító" : "teszt üzemmód"}
      </footer>
    </div>
  );
}
