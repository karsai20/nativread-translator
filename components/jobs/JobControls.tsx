"use client";

import * as React from "react";
import Link from "next/link";
import { Pause, Play, Square, Trash2, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ConfirmDialog } from "./ConfirmDialog";
import type { JobStatus } from "@/lib/jobs/types";

interface JobControlsProps {
  id: string;
  status: JobStatus;
  title: string;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}

function IconButton({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function JobControls({ id, status, title, onPause, onResume, onCancel, onDelete }: JobControlsProps) {
  const canPause = status === "running" || status === "pending";
  const canResume = status === "paused" || status === "error" || status === "cancelled";
  const canCancel = status === "running" || status === "pending" || status === "paused";

  return (
    <div className="flex shrink-0 items-center gap-2">
      {canResume && (
        <IconButton label={status === "paused" ? "Folytatás" : "Újraindítás"} onClick={() => onResume(id)}>
          <Play />
        </IconButton>
      )}
      {canPause && (
        <IconButton label="Szünet" onClick={() => onPause(id)}>
          <Pause />
        </IconButton>
      )}
      {canCancel && (
        <ConfirmDialog
          title="Fordítás megszakítása?"
          description={`A(z) „${title}” fordítása leáll. A kész részek megmaradnak, később törölheted.`}
          confirmLabel="Megszakítás"
          onConfirm={() => onCancel(id)}
          trigger={
            <span>
              <IconButton label="Megszakítás">
                <Square />
              </IconButton>
            </span>
          }
        />
      )}

      {status === "done" && (
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/read/${encodeURIComponent(id)}`}>
            <BookOpen />
            Olvasás
          </Link>
        </Button>
      )}

      <ConfirmDialog
        title="Törlés véglegesen?"
        description={`A(z) „${title}” munkamenet és a lefordított részek törlődnek. Ez nem visszavonható.`}
        confirmLabel="Törlés"
        onConfirm={() => onDelete(id)}
        trigger={
          <span>
            <IconButton label="Törlés">
              <Trash2 />
            </IconButton>
          </span>
        }
      />
    </div>
  );
}
