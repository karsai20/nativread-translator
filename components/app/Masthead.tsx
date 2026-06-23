"use client";

import { ThemeToggle } from "./ThemeToggle";

export function Masthead() {
  return (
    <header className="sticky top-0 z-20">
      <div className="surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5 sm:px-8">
          <a href="/" className="group flex items-baseline gap-2.5">
            <span aria-hidden className="relative top-[1px] inline-block size-2.5 rotate-45 rounded-[2px] bg-primary transition-transform duration-500 group-hover:rotate-[135deg]" />
            <span className="display text-xl font-semibold tracking-[-0.01em]">Átirat</span>
            <span className="hidden text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground sm:inline">
              könyvfordító
            </span>
          </a>
          <ThemeToggle />
        </div>
      </div>
      <div className="rule" />
    </header>
  );
}
