import * as React from "react";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/jobs/format";
import type { CostState } from "@/lib/core/cost";

const WARN_RATIO = 0.8;

export function CostMeter({ cost, className }: { cost: CostState; className?: string }) {
  const ratio = cost.ceilingUsd > 0 ? Math.min(1, cost.usd / cost.ceilingUsd) : 0;
  const near = ratio >= WARN_RATIO;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-muted-foreground">Költség</span>
        <span className={cn("tnum font-medium", near ? "text-warning" : "text-foreground")}>
          {formatUsd(cost.usd)}{" "}
          <span className="text-muted-foreground">/ {formatUsd(cost.ceilingUsd)}</span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", near ? "bg-warning" : "bg-primary")}
          style={{ width: `${Math.max(2, ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}
