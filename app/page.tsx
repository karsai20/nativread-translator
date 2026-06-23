"use client";

import * as React from "react";
import { Uploader } from "@/components/app/Uploader";
import { ProgressView } from "@/components/app/ProgressView";
import { Reader } from "@/components/app/Reader";
import { Library } from "@/components/app/Library";
import { Masthead } from "@/components/app/Masthead";
import { TranslationHero } from "@/components/app/TranslationHero";
import { Colophon } from "@/components/app/Colophon";
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
    <div className="min-h-screen">
      <Masthead />

      <main className="mx-auto max-w-5xl px-5 pb-28 sm:px-8">
        {view === "upload" && (
          <div className="pt-12 sm:pt-20">
            <TranslationHero />

            <div className="mt-10 sm:mt-14">
              <Colophon books={books} provider={provider} />
            </div>

            <div className="rule my-12 sm:my-16" />

            <div className="grid gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
              <Uploader providerName={provider} onStart={start} />
              <Library books={books} onOpen={openReader} />
            </div>
          </div>
        )}

        {view === "progress" && (
          <div className="mx-auto max-w-2xl pt-16 sm:pt-24">
            <ProgressView state={state} />
          </div>
        )}

        {view === "reader" && jobId && (
          <div className="mx-auto max-w-2xl pt-10">
            <Reader items={items} downloadHref={`/api/result?id=${encodeURIComponent(jobId)}&download=1`} />
            <div className="mt-8">
              <Button variant="ghost" onClick={reset}>
                ← Új könyv fordítása
              </Button>
            </div>
          </div>
        )}

        {view === "error" && (
          <section className="mx-auto max-w-2xl space-y-5 pt-20">
            <h1 className="display text-4xl font-semibold">Valami félrement</h1>
            <p className="rounded-[var(--radius)] border-l-2 border-destructive bg-card px-4 py-3 text-card-foreground">
              {error}
            </p>
            <Button variant="ghost" onClick={reset}>
              ← Újrakezdés
            </Button>
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-5xl px-5 pb-12 sm:px-8">
        <div className="rule mb-6" />
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          Átirat · helyi fordítóműhely · házi hálózat
        </p>
      </footer>
    </div>
  );
}
