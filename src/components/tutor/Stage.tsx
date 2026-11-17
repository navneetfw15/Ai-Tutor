"use client";

import { AlertCircle, CornerUpLeft, Loader2, MessageCircleQuestion, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useEngineState, type Prefs } from "@/lib/client/hooks";
import type { AudioProgress, Playable } from "@/lib/client/useTutor";
import { boardAt } from "@/lib/lesson/timeline";
import type { PlaybackEngine } from "@/lib/playback/engine";
import { cn, formatTime } from "@/lib/utils";
import { Captions } from "./Captions";
import { Controls } from "./Controls";
import { Whiteboard, type UserStroke } from "./Whiteboard";

interface Props {
  engine: PlaybackEngine;
  playable: Playable | null;
  activeMessageId: string | null;
  audio: AudioProgress | undefined;
  isAnswer: boolean;
  title: string;
  resumeAt: number | null;
  onResume: () => void;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  onRetryAudio: () => void;
  onBrowserVoice: () => void;
}

export function Stage({
  engine,
  playable,
  activeMessageId,
  audio,
  isAnswer,
  title,
  resumeAt,
  onResume,
  prefs,
  onPrefs,
  onRetryAudio,
  onBrowserVoice,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const time = useEngineState(engine, (s) => s.time);
  const playing = useEngineState(engine, (s) => s.playing);
  const ended = useEngineState(engine, (s) => s.ended);
  const buffering = useEngineState(engine, (s) => s.buffering);
  const blocked = useEngineState(engine, (s) => s.blocked);

  const timeline = playable?.timeline ?? null;
  const board = useMemo(() => (timeline ? boardAt(timeline, time) : null), [timeline, time]);

  // The learner's own pen strokes are kept per board page.
  const [strokes, setStrokes] = useState<Record<string, UserStroke[]>>({});
  const strokeKey = `${activeMessageId ?? "none"}:${board?.scene ?? 0}`;
  const setCurrentStrokes = useCallback((next: UserStroke[]) => setStrokes((prev) => ({ ...prev, [strokeKey]: next })), [strokeKey]);

  // ---- full screen ----
  const [isFs, setIsFs] = useState(false);
  // Client-only capability: false on the server and during hydration, then the real value.
  const fsSupported = useSyncExternalStore(
    () => () => undefined,
    () => !!document.documentElement.requestFullscreen,
    () => false,
  );
  useEffect(() => {
    const onChange = () => setIsFs(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      const onButton = tag === "BUTTON" || tag === "A";
      switch (e.key) {
        case " ":
          if (onButton) return;
          e.preventDefault();
          engine.toggle();
          break;
        case "ArrowLeft":
          engine.seekBy(-5000);
          break;
        case "ArrowRight":
          engine.seekBy(5000);
          break;
        case "m":
          engine.setMuted(!engine.getSnapshot().muted);
          onPrefs({ muted: engine.getSnapshot().muted });
          break;
        case "c":
          onPrefs({ captions: !prefs.captions });
          break;
        case "f":
          if (fsSupported) toggleFs();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, fsSupported, onPrefs, prefs.captions, toggleFs]);

  const notStarted = !!playable && !playing && !ended && time === 0;

  return (
    <div
      ref={rootRef}
      className={cn("flex min-w-0 flex-col gap-3", isFs && "h-dvh bg-bg p-3 sm:p-5")}
      data-testid="stage"
    >
      <div className="flex items-center gap-2 px-1 text-sm">
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-semibold",
            isAnswer ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted",
          )}
        >
          {isAnswer ? "Answer" : "Lesson"}
        </span>
        <span className="truncate font-medium" title={title}>
          {title}
        </span>
        {playable && (
          <span className="ml-auto hidden shrink-0 text-xs text-faint sm:inline">
            {playable.source.mode === "audio" ? "Studio voice" : "Browser voice"}
          </span>
        )}
      </div>

      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border border-board-frame bg-[var(--board)] shadow-card ring-1 ring-black/5",
          isFs ? "min-h-0 flex-1" : "aspect-[16/10] w-full",
        )}
      >
        <Whiteboard
          board={board}
          strokes={strokes[strokeKey] ?? []}
          onStrokesChange={setCurrentStrokes}
          isFullscreen={isFs}
          onToggleFullscreen={fsSupported ? toggleFs : () => undefined}
          resetKey={activeMessageId ?? ""}
        />

        {buffering && playing && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white backdrop-blur">
            <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
            Buffering…
          </div>
        )}

        {/* Overlays */}
        {!playable && (
          <Overlay>
            {audio?.status === "failed" ? (
              <>
                <AlertCircle className="size-9 text-danger" />
                <p className="text-base font-semibold text-zinc-900">The voice recording hit a snag</p>
                <p className="max-w-xs text-sm text-zinc-600">{audio.error ?? "We couldn't record the narration."}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={onRetryAudio} className="btn-primary rounded-xl px-4 py-2 text-sm font-semibold">
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={onBrowserVoice}
                    className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
                  >
                    Use browser voice
                  </button>
                </div>
              </>
            ) : activeMessageId ? (
              <>
                <Loader2 className="size-9 animate-spin text-accent" />
                <p className="text-base font-semibold text-zinc-900" data-testid="preparing">
                  Recording the narration…
                </p>
                {audio && audio.total > 0 && (
                  <>
                    <div className="h-1.5 w-48 overflow-hidden rounded-full bg-zinc-200">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-500"
                        style={{ width: `${Math.max(6, (audio.done / audio.total) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-zinc-500">
                      Scene {Math.min(audio.done + 1, audio.total)} of {audio.total}
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                <MessageCircleQuestion className="size-9 text-accent" />
                <p className="text-base font-semibold text-zinc-900">Nothing to show yet</p>
              </>
            )}
          </Overlay>
        )}

        {notStarted && (
          <Overlay subtle>
            <button
              type="button"
              onClick={() => engine.play()}
              aria-label="Start the lesson"
              data-testid="start-overlay"
              className="group relative grid size-20 place-items-center rounded-full btn-primary shadow-pop transition-transform hover:scale-105"
            >
              <span className="absolute inset-0 animate-pulse-ring rounded-full bg-accent/40" aria-hidden />
              <Play className="relative ml-1 size-9 fill-current" />
            </button>
            <p className="text-sm font-medium text-zinc-800">
              {blocked ? "Tap to start the voice" : isAnswer ? "Play the answer" : "Press play to start the lesson"}
            </p>
            {playable && <p className="-mt-1 text-xs text-zinc-500">{formatTime(playable.timeline.duration)} · {playable.timeline.scenes.length} scenes</p>}
          </Overlay>
        )}

        {ended && playable && (
          <Overlay subtle>
            <p className="text-base font-semibold text-zinc-900">{isAnswer ? "That's the answer" : "That's the lesson!"}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {resumeAt !== null && (
                <button
                  type="button"
                  onClick={onResume}
                  className="btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold"
                  data-testid="resume-lesson"
                >
                  <CornerUpLeft className="size-4" />
                  Back to the lesson
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  engine.restart();
                  engine.play();
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold",
                  resumeAt === null
                    ? "btn-primary"
                    : "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50",
                )}
                data-testid="replay"
              >
                <RotateCcw className="size-4" />
                Replay
              </button>
            </div>
            <p className="max-w-xs text-xs text-zinc-500">Have a question? Ask it in the chat and I&apos;ll explain it on the board.</p>
          </Overlay>
        )}
      </div>

      {prefs.captions && <Captions engine={engine} timeline={timeline} />}

      <Controls engine={engine} timeline={timeline} prefs={prefs} onPrefs={onPrefs} />

      {timeline && timeline.scenes.length > 1 && (
        <nav aria-label="Chapters" className="chapters-strip hidden md:block">
          <ol className="scroll-soft flex gap-2 overflow-x-auto pb-1">
            {timeline.scenes.map((s) => {
              const current = board?.scene === s.index;
              return (
                <li key={s.index} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      engine.seekToScene(s.index);
                      engine.play();
                    }}
                    aria-current={current ? "step" : undefined}
                    data-testid={`chapter-${s.index}`}
                    className={cn(
                      "flex max-w-[15rem] items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                      current
                        ? "border-accent/50 bg-accent-soft text-fg"
                        : "border-line bg-surface text-muted hover:border-accent/40 hover:text-fg",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                        current ? "bg-accent text-accent-fg" : "bg-surface-2",
                      )}
                    >
                      {s.index + 1}
                    </span>
                    <span className="truncate">{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
    </div>
  );
}

function Overlay({ children, subtle }: { children: React.ReactNode; subtle?: boolean }) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center animate-fade-in",
        subtle ? "bg-white/70 backdrop-blur-[2px]" : "bg-white/88 backdrop-blur-sm",
      )}
    >
      {children}
    </div>
  );
}
