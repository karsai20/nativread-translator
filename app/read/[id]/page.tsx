"use client";

import * as React from "react";
import Link from "next/link";
import { use } from "react";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { Reader } from "@/components/reader/Reader";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import type { ReaderItem } from "@/lib/jobs/types";

interface ResultData {
  title: string;
  items: ReaderItem[];
  sample?: boolean;
}

export default function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = React.useState<ResultData | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/result?id=${encodeURIComponent(id)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Az eredmény nem tölthető be.");
        if (!cancelled) setData(body as ResultData);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-3.5 sm:px-8">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/library">
              <ArrowLeft />
              Könyvtár
            </Link>
          </Button>
          <h1 className="display min-w-0 flex-1 truncate text-center text-base font-semibold sm:text-lg">
            {data?.title ?? ""}
          </h1>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
        {error ? (
          <div className="space-y-4 rounded-[var(--radius)] border-l-2 border-destructive bg-card px-4 py-3">
            <p className="text-card-foreground">{error}</p>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/">← Vissza az áttekintéshez</Link>
            </Button>
          </div>
        ) : !data ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            {data.sample && (
              <div className="mb-6 flex items-start gap-3 rounded-[var(--radius)] border border-primary/40 bg-accent/40 px-4 py-3">
                <FlaskConical className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-sm text-card-foreground">
                  <span className="font-medium">Próbafordítás — az első tartalmi fejezet.</span>{" "}
                  Csak a könyv eleje lett lefordítva, a többi eredeti nyelven maradt. A teljes
                  fordításhoz{" "}
                  <Link href="/" className="font-medium underline underline-offset-2">
                    tölts fel újra
                  </Link>{" "}
                  a könyvet a próba-kapcsoló nélkül.
                </p>
              </div>
            )}
            <Reader items={data.items} downloadHref={`/api/result?id=${encodeURIComponent(id)}&download=1`} />
          </>
        )}
      </main>
    </div>
  );
}
