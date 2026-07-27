"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Library, Settings, BookOpenText, PanelLeftClose, PanelLeft, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "./SidebarProvider";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV: NavItem[] = [
  { href: "/", label: "Áttekintés", icon: LayoutDashboard },
  { href: "/library", label: "Könyvtár", icon: Library },
  { href: "/settings", label: "Beállítások", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppSidebar() {
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useSidebar();
  const pathname = usePathname();

  return (
    <>
      {/* Mobile scrim */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[2px] md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200 md:static md:translate-x-0",
          collapsed ? "md:w-[4.5rem]" : "md:w-60",
          "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <div className="flex h-16 items-center gap-2.5 px-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius)] bg-primary text-primary-foreground">
            <BookOpenText className="size-5" />
          </span>
          {!collapsed && (
            <div className="min-w-0">
              <p className="display truncate text-base font-semibold leading-tight">NativRead</p>
              <p className="truncate text-xs text-muted-foreground">Web</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="ml-auto grid size-8 place-items-center rounded-md text-muted-foreground hover:text-foreground md:hidden"
            aria-label="Menü bezárása"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                title={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-[var(--radius)] px-3 py-2.5 text-sm font-medium transition-colors",
                  collapsed && "md:justify-center md:px-0",
                  active
                    ? "bg-sidebar-accent text-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <item.icon className="size-[1.15rem] shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div
          className={cn(
            "flex items-center gap-2 border-t border-sidebar-border px-3 py-3",
            collapsed && "md:flex-col",
          )}
        >
          <ThemeToggle />
          <button
            type="button"
            onClick={toggleCollapsed}
            className="hidden size-9 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary md:inline-grid"
            aria-label={collapsed ? "Oldalsáv kinyitása" : "Oldalsáv összecsukása"}
          >
            {collapsed ? <PanelLeft className="size-[1.05rem]" /> : <PanelLeftClose className="size-[1.05rem]" />}
          </button>
        </div>
      </aside>
    </>
  );
}
