"use client";

import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Header } from "@/components/brand/Header";
import { usePrefs } from "@/lib/client/hooks";
import { useTutor } from "@/lib/client/useTutor";
import { ChatPanel } from "./ChatPanel";
import { Stage } from "./Stage";

export function Workspace({ lessonId }: { lessonId: string }) {
  const tutor = useTutor(lessonId);
  const { engine } = tutor;
  const [prefs, setPrefs] = usePrefs();

  // Apply saved viewer preferences to the engine.
  useEffect(() => {
    engine.setRate(prefs.rate);
    engine.setMuted(prefs.muted);
  }, [engine, prefs.rate, prefs.muted]);

  // Development-only hook so browser tests can seek to exact moments. Never present in production builds.
  const { active } = tutor;
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __wbt?: unknown }).__wbt = { engine, active };
  }, [engine, active]);

  if (tutor.phase === "loading") return <WorkspaceSkeleton />;
  if (tutor.phase === "error") {
    return (
      <div className="flex min-h-dvh flex-col">
        <Header showNew />
        <main className="grid flex-1 place-items-center p-6">
          <div className="max-w-sm space-y-4 text-center animate-fade-up" role="alert" data-testid="load-error">
            <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-danger-soft text-danger">
              <AlertTriangle className="size-7" />
            </span>
            <h1 className="text-xl font-semibold">{tutor.loadError?.notFound ? "Lesson not found" : "Couldn't load the lesson"}</h1>
            <p className="text-sm text-muted">{tutor.loadError?.message}</p>
            <div className="flex justify-center gap-2">
              {!tutor.loadError?.notFound && (
                <button type="button" onClick={tutor.reload} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold hover:border-accent/50">
                  <RefreshCw className="size-4" /> Try again
                </button>
              )}
              <Link href="/" className="btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold">
                <ArrowLeft className="size-4" /> Start a new lesson
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const { lesson, activeId, lessonMessage } = tutor;
  const isAnswer = !!activeId && activeId !== lessonMessage?.id;
  const activeMessage = tutor.messages.find((m) => m.id === activeId);
  const stageTitle = active?.message.script?.title ?? activeMessage?.script?.title ?? lesson?.title ?? "";

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <Header title={lesson?.title} currentLessonId={lessonId} />
      <main className="workspace-grid grid min-h-0 flex-1 gap-4 p-3 sm:p-4">
        <div className="min-w-0 max-md:sticky max-md:top-0 max-md:z-30 max-md:-mx-3 max-md:bg-bg/95 max-md:px-3 max-md:pb-2 max-md:backdrop-blur lg:overflow-y-auto lg:pr-1">
          <Stage
            engine={engine}
            playable={active}
            activeMessageId={activeId}
            audio={activeId ? tutor.audio[activeId] : undefined}
            isAnswer={isAnswer}
            title={stageTitle}
            resumeAt={tutor.resume && activeId !== tutor.resume.id ? tutor.resume.time : null}
            onResume={tutor.resumeLesson}
            prefs={prefs}
            onPrefs={setPrefs}
            onRetryAudio={() => activeId && tutor.retryAudio(activeId)}
            onBrowserVoice={() => activeId && tutor.switchToBrowserVoice(activeId)}
          />
        </div>
        <div className="flex min-h-[26rem] min-w-0 flex-col lg:min-h-0">
          <ChatPanel tutor={tutor} isOwner={!!lesson?.isOwner} />
        </div>
      </main>
    </div>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true" aria-label="Loading lesson" data-testid="workspace-skeleton">
      <header className="flex h-14 items-center border-b border-line px-5">
        <div className="h-8 w-40 rounded-xl bg-surface-2" />
      </header>
      <main className="grid flex-1 gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="space-y-3">
          <div className="aspect-[16/10] w-full animate-pulse rounded-2xl bg-surface-2" />
          <div className="h-14 animate-pulse rounded-xl bg-surface-2" />
          <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
        </div>
        <div className="hidden animate-pulse rounded-2xl bg-surface-2 lg:block" />
      </main>
    </div>
  );
}
