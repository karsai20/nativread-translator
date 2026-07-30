"use client";

import * as React from "react";
import { Menu } from "lucide-react";
import { useSidebar } from "./SidebarProvider";

interface DashboardHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}

export function DashboardHeader({ title, subtitle, action }: DashboardHeaderProps) {
  const { setMobileOpen } = useSidebar();

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/80 px-5 py-4 backdrop-blur-sm sm:px-8">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="grid size-9 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground md:hidden"
        aria-label="Menü megnyitása"
      >
        <Menu className="size-5" />
      </button>

      <div className="min-w-0">
        <h1 className="display truncate text-xl font-semibold leading-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
      </div>

      {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
    </header>
  );
}
