"use client";

import * as React from "react";

// The product, shown not told: a real literary line in English, re-written into Hungarian
// in front of you. Famous openings cycle, the translation blurring in on each turn.
const LINES: { en: string; hu: string; from: string }[] = [
  {
    en: "It was a bright cold day in April, and the clocks were striking thirteen.",
    hu: "Derült, hideg áprilisi nap volt, és az órák éppen tizenhármat ütöttek.",
    from: "Orwell · 1984",
  },
  {
    en: "All happy families are alike; each unhappy family is unhappy in its own way.",
    hu: "A boldog családok mind hasonlók egymáshoz, minden boldogtalan család a maga módján boldogtalan.",
    from: "Tolsztoj · Anna Karenina",
  },
  {
    en: "It is a truth universally acknowledged that a single man in possession of a good fortune must be in want of a wife.",
    hu: "Általánosan elismert igazság, hogy a legényembernek, ha vagyona van, okvetlenül feleség kell.",
    from: "Austen · Büszkeség és balítélet",
  },
];

const HOLD_MS = 4600;
const BLUR_MS = 460;

export function TranslationHero() {
  const [i, setI] = React.useState(0);
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return; // static for reduced motion
    }
    const id = setInterval(() => {
      setVisible(false);
      window.setTimeout(() => {
        setI((x) => (x + 1) % LINES.length);
        setVisible(true);
      }, BLUR_MS);
    }, HOLD_MS);
    return () => clearInterval(id);
  }, []);

  const line = LINES[i]!;
  const morph = `morph ${visible ? "" : "morph-hidden"}`;

  return (
    <section aria-label="Élő fordítás" className="rise">
      <p className="mb-5 flex items-center gap-3 text-[0.7rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-primary" />
        Élő fordítás
      </p>

      <div className="relative">
        {/* English source — muted, italic, the "before". */}
        <p className={`${morph} font-sans text-base italic leading-relaxed text-muted-foreground sm:text-lg`}>
          {line.en}
        </p>

        {/* The turn. */}
        <div className="my-4 flex items-center gap-4">
          <span aria-hidden className="display text-2xl text-primary">↓</span>
          <span className="h-px flex-1 bg-border" />
          <span className={`${morph} text-xs uppercase tracking-widest text-muted-foreground`}>{line.from}</span>
        </div>

        {/* Hungarian — the big, solid "after". */}
        <p
          className={`${morph} display text-balance text-3xl font-medium leading-[1.12] tracking-[-0.01em] sm:text-[2.7rem] sm:leading-[1.08]`}
        >
          {line.hu}
        </p>
      </div>
    </section>
  );
}
