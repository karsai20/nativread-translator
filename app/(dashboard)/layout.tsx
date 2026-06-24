import * as React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/shell/SidebarProvider";
import { AppSidebar } from "@/components/shell/AppSidebar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider>
        <div className="flex min-h-screen">
          <AppSidebar />
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
