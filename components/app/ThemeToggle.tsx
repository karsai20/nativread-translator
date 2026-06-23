"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";

/** Toggles the .dark class on <html> and persists the choice. Initial state is set
 *  before paint by the inline script in layout.tsx, so there is no flash. */
export function ThemeToggle() {
  const [dark, setDark] = React.useState(true);

  React.useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* private mode — fine, just won't persist */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Váltás világos módra" : "Váltás sötét módra"}
      className="group inline-grid size-9 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary"
    >
      <Sun className="size-[1.05rem] scale-100 rotate-0 transition-transform duration-500 group-hover:rotate-45 dark:hidden" />
      <Moon className="hidden size-[1.05rem] transition-transform duration-500 group-hover:-rotate-12 dark:block" />
    </button>
  );
}
