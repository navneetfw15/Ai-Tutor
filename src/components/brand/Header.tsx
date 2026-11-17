"use client";

import { History, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { HistoryDrawer } from "./HistoryDrawer";
import { Logo } from "./Logo";

export function Header({ title, currentLessonId, showNew = true }: { title?: string; currentLessonId?: string; showNew?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="z-40 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg/85 px-3 backdrop-blur sm:px-5">
        <Logo />
        {title && (
          <h1 className="min-w-0 flex-1 truncate text-center text-sm font-medium text-muted sm:text-left sm:pl-2" title={title}>
            {title}
          </h1>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-medium text-muted transition-colors hover:border-accent/40 hover:text-fg"
            aria-label="Lesson history"
            data-testid="open-history"
          >
            <History className="size-4" />
            <span className="hidden sm:inline">History</span>
          </button>
          {showNew && (
            <Link
              href="/"
              className="btn-primary inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold"
              data-testid="new-lesson"
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">New lesson</span>
            </Link>
          )}
        </div>
      </header>
      <HistoryDrawer open={open} onClose={() => setOpen(false)} currentLessonId={currentLessonId} />
    </>
  );
}
