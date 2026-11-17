"use client";

import { BookOpen, Loader2, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ClientApiError } from "@/lib/client/api";
import type { LessonSummaryDTO } from "@/lib/lesson/dto";
import { cn, timeAgo } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  currentLessonId?: string;
}

/** Slide-over list of the visitor's lessons. The panel mounts only while open, so state starts fresh. */
export function HistoryDrawer({ open, onClose, currentLessonId }: Props) {
  if (!open) return null;
  return <DrawerPanel onClose={onClose} currentLessonId={currentLessonId} />;
}

function DrawerPanel({ onClose, currentLessonId }: Omit<Props, "open">) {
  const router = useRouter();
  const [lessons, setLessons] = useState<LessonSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let cancelled = false;
    api
      .listLessons()
      .then((r) => !cancelled && setLessons(r.lessons))
      .catch((e: unknown) => !cancelled && setError(e instanceof ClientApiError ? e.message : "Could not load your lessons."));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api.deleteLesson(id);
      setLessons((prev) => prev?.filter((l) => l.id !== id) ?? null);
      setConfirming(null);
      if (id === currentLessonId) {
        onClose();
        router.push("/");
      }
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Could not delete that lesson.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Lesson history">
      <button type="button" aria-label="Close history" className="absolute inset-0 animate-fade-in bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-md animate-fade-up flex-col border-l border-line bg-surface shadow-pop">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-base font-semibold">Your lessons</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-5" />
          </button>
        </div>

        <div className="scroll-soft flex-1 overflow-y-auto p-3">
          {error && (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
              <span>{error}</span>
              <button
                type="button"
                className="shrink-0 text-xs font-semibold underline"
                onClick={() => {
                  setError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}
          {lessons === null && !error && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {lessons?.length === 0 && (
            <div className="grid place-items-center gap-2 py-16 text-center text-sm text-muted">
              <BookOpen className="size-8 text-faint" />
              <p>No lessons yet. Ask about anything to get started!</p>
            </div>
          )}
          <ul className="space-y-2">
            {lessons?.map((l) => (
              <li key={l.id}>
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-xl border p-3 transition-colors",
                    l.id === currentLessonId ? "border-accent/50 bg-accent-soft" : "border-line hover:border-accent/40",
                  )}
                >
                  <Link href={`/lesson/${l.id}`} onClick={onClose} className="min-w-0 flex-1" data-testid="history-item">
                    <p className="truncate text-sm font-semibold">{l.title}</p>
                    <p className="truncate text-xs text-muted">
                      {l.topic} · {timeAgo(l.createdAt)}
                    </p>
                  </Link>
                  {confirming === l.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => remove(l.id)}
                        disabled={busy === l.id}
                        className="rounded-lg bg-danger px-2.5 py-1.5 text-xs font-semibold text-white"
                        data-testid="confirm-delete"
                      >
                        {busy === l.id ? "…" : "Delete"}
                      </button>
                      <button type="button" onClick={() => setConfirming(null)} className="rounded-lg px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-2">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirming(l.id)}
                      aria-label={`Delete ${l.title}`}
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-faint opacity-60 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
