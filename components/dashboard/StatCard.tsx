import * as React from "react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}

export function StatCard({ label, value, hint, icon: Icon, className }: StatCardProps) {
  return (
    <div className={cn("rounded-[calc(var(--radius)+0.2rem)] border border-border bg-card p-4", className)}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
      </div>
      <p className="tnum mt-2 font-serif text-2xl font-semibold leading-none">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
