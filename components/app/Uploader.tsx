"use client";

import * as React from "react";
import { UploadCloud, BookOpen, Info } from "lucide-react";
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
    <section aria-labelledby="upload-heading" className="space-y-6">
      <div className="space-y-2">
        <h1 id="upload-heading" className="font-serif text-4xl leading-tight text-balance sm:text-5xl">
          Melyik könyvet fordítsuk le?
        </h1>
        <p className="text-muted-foreground">
          Tölts fel egy EPUB könyvet, és pár perc múlva magyarul olvashatod.
        </p>
      </div>

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
          "flex cursor-pointer flex-col items-center gap-3 rounded-[calc(var(--radius)+0.4rem)] border-2 border-dashed border-border bg-card px-6 py-14 text-center transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-[0_18px_50px_-30px_var(--color-primary)]",
          drag && "border-primary -translate-y-0.5",
          file && "border-good border-solid",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".epub,application/epub+zip"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <span className="grid size-14 place-items-center rounded-full bg-accent text-accent-foreground">
          {file ? <BookOpen className="size-6" /> : <UploadCloud className="size-6" />}
        </span>
        <span className="text-lg font-semibold">{file ? file.name : "Válassz egy EPUB könyvet"}</span>
        <span className="text-sm text-muted-foreground">vagy húzd ide a fájlt</span>
      </label>

      <p className="flex items-start gap-2 rounded-[var(--radius)] border-l-2 border-primary bg-card px-4 py-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          A fordításhoz a könyv szövege elküldésre kerül a fordítószolgáltatónak
          {providerName === "fake" ? " (most teszt üzemmód, valódi küldés nélkül)" : ""}.
        </span>
      </p>

      <Button size="lg" disabled={!file} onClick={() => file && onStart(file)} className="w-full sm:w-auto">
        Fordítás indítása
      </Button>
    </section>
  );
}
