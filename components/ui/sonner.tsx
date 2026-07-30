"use client";

import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/components/shell/ThemeToggle";

export function Toaster() {
  const { theme } = useTheme();
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-[var(--radius)] !border !border-border !bg-card !text-card-foreground !shadow-lg",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
        },
      }}
    />
  );
}
