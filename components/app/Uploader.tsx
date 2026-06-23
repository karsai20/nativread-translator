"use client";

import * as React from "react";
import { BookOpen, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UploaderProps {
  providerName: string;
  onStart: (file: File) => void;
}

export function Uploader({ providerName, onStart }: UploaderProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [drag, setDrag] = React.useState(false);

  const pick = (f: File | null | undefined) => f && setFile(f);

  return (
    <section aria-labelledby="upload-heading" className="rise">
      <p className="mb-3 text-[0.7rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        Új kézirat
      </p>
      <h2 id="upload-heading" className="display text-balance text-3xl font-semibold leading-tight sm:text-4xl">
        Melyik könyvet olvassuk magyarul?
      </h2>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "group mt-7 flex cursor-pointer items-center gap-4 rounded-[var(--radius)] border border-border bg-card/60 px-5 py-5 transition-all hover:border-primary hover:bg-card",
          drag && "border-primary bg-card",
          file && "border-good/70",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".epub,application/epub+zip"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <span
          className={cn(
            "grid size-12 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-transform group-hover:scale-105",
            file && "bg-good/15 text-good",
          )}
        >
          {file ? <BookOpen className="size-5" /> : <UploadCloud className="size-5" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">{file ? file.name : "Válassz vagy húzz ide egy EPUB-ot"}</span>
          <span className="block text-sm text-muted-foreground">
            {file ? "Készen áll a fordításra" : "EPUB formátum, bármilyen méret"}
          </span>
        </span>
      </label>

      <p className="mt-4 text-[0.78rem] leading-relaxed text-muted-foreground">
        A fordításhoz a könyv szövege a fordítószolgáltatóhoz kerül
        {providerName === "fake" ? " — most teszt üzemmód, valódi küldés nélkül." : "."}
      </p>

      <Button size="lg" disabled={!file} onClick={() => file && onStart(file)} className="mt-7 w-full sm:w-auto">
        Fordítás indítása
      </Button>
    </section>
  );
}
