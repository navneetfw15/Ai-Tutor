"use client";

import { CornerUpLeft, Loader2, Play, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEngineState } from "@/lib/client/hooks";
import type { useTutor } from "@/lib/client/useTutor";
import type { MessageDTO } from "@/lib/lesson/dto";
import { cn, formatTime } from "@/lib/utils";

type Tutor = ReturnType<typeof useTutor>;

const MAX_QUESTION = 500;

export function ChatPanel({ tutor, isOwner }: { tutor: Tutor; isOwner: boolean }) {
  const { engine, messages, asking, askError, audio, playables, activeId, resume } = tutor;
  const playing = useEngineState(engine, (s) => s.playing);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, asking]);

  const lastWithSuggestions = [...messages].reverse().find((m) => m.role === "assistant" && m.suggestions.length > 0);
  const showSuggestions = isOwner && !asking && lastWithSuggestions && messages[messages.length - 1]?.id === lastWithSuggestions.id;

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-surface shadow-soft lg:h-full" aria-label="Conversation">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles className="size-4 text-accent" />
        <h2 className="text-sm font-semibold">Ask your tutor</h2>
      </div>

      <div ref={scrollRef} className="scroll-soft min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-4" data-testid="messages">
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            isActive={activeId === m.id}
            isPlaying={activeId === m.id && playing}
            durationMs={playables[m.id]?.timeline.duration ?? null}
            audio={audio[m.id]}
            isLesson={m.id === tutor.lessonMessage?.id}
            onPlay={() => tutor.playMessage(m.id, { from: 0, autoplay: true })}
            onChapter={(i) => {
              const p = playables[m.id];
              if (!p) return;
              tutor.playMessage(m.id, { from: p.timeline.scenes[i].start, autoplay: true });
            }}
          />
        ))}
        {asking && <TypingBubble />}
      </div>

      <div className="shrink-0 space-y-2 border-t border-line p-3">
        {showSuggestions && (
          <div className="flex flex-wrap gap-2" data-testid="suggestions">
            {lastWithSuggestions.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void tutor.ask(s)}
                className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-left text-xs font-medium text-muted transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-fg"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {resume && activeId !== resume.id && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-accent-soft px-3 py-2 text-sm" data-testid="resume-banner">
            <span className="min-w-0 truncate text-muted">
              Your lesson is paused at <b className="text-fg">{formatTime(resume.time)}</b>
            </span>
            <button type="button" onClick={tutor.resumeLesson} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg">
              <CornerUpLeft className="size-3.5" /> Resume
            </button>
          </div>
        )}

        {askError && (
          <div className="flex items-start justify-between gap-2 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" role="alert" data-testid="ask-error">
            <span>{askError}</span>
            <button type="button" onClick={tutor.clearAskError} className="shrink-0 text-xs font-semibold underline">
              Dismiss
            </button>
          </div>
        )}

        {isOwner ? (
          <Composer busy={asking} onSend={tutor.ask} />
        ) : (
          <div className="rounded-xl bg-surface-2 px-3 py-3 text-center text-sm text-muted">
            You&apos;re viewing a shared lesson.{" "}
            <Link href="/" className="font-semibold text-accent underline-offset-2 hover:underline">
              Start your own
            </Link>{" "}
            to ask questions.
          </div>
        )}
      </div>
    </section>
  );
}

function Message({
  message,
  isActive,
  isPlaying,
  durationMs,
  audio,
  isLesson,
  onPlay,
  onChapter,
}: {
  message: MessageDTO;
  isActive: boolean;
  isPlaying: boolean;
  durationMs: number | null;
  audio: Tutor["audio"][string] | undefined;
  isLesson: boolean;
  onPlay: () => void;
  onChapter: (i: number) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end animate-fade-up" data-testid="user-message">
        <p className="max-w-[88%] rounded-2xl rounded-br-md bg-gradient-to-br from-accent to-accent-2 px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-white shadow-soft">
          {message.text}
        </p>
      </div>
    );
  }

  const script = message.script;
  const hasScript = !!script && script.scenes.length > 0;
  const preparing = hasScript && durationMs === null && audio?.status !== "failed";

  return (
    <div className="flex gap-2.5 animate-fade-up" data-testid="assistant-message">
      <span className="btn-primary mt-0.5 grid size-7 shrink-0 place-items-center rounded-full">
        <Sparkles className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        {message.text && (
          <p className="rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-fg whitespace-pre-wrap">{message.text}</p>
        )}
        {hasScript && (
          <div
            className={cn(
              "rounded-2xl border bg-surface p-3 transition-shadow",
              isActive ? "border-accent/60 shadow-card ring-2 ring-accent/15" : "border-line",
            )}
            data-testid={isLesson ? "lesson-card" : "answer-card"}
          >
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onPlay}
                disabled={durationMs === null}
                aria-label={isPlaying ? "Playing" : isLesson ? "Play lesson" : "Play answer"}
                data-testid="card-play"
                className="btn-primary grid size-11 shrink-0 place-items-center rounded-full disabled:cursor-wait"
              >
                {preparing ? <Loader2 className="size-5 animate-spin" /> : isPlaying ? <Equalizer /> : <Play className="ml-0.5 size-5 fill-current" />}
              </button>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-wide text-faint uppercase">
                  {isLesson ? "Lesson" : "Answer"}
                  {durationMs !== null ? ` · ${formatTime(durationMs)}` : ""}
                </p>
                <p className="text-sm leading-snug font-semibold">{script!.title}</p>
              </div>
            </div>

            {preparing && audio && audio.total > 0 && (
              <div className="mt-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-500"
                    style={{ width: `${Math.max(6, (audio.done / audio.total) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  Recording voice… {audio.done}/{audio.total}
                </p>
              </div>
            )}
            {audio?.status === "failed" && <p className="mt-2 text-xs text-danger">Voice recording failed — see the whiteboard for options.</p>}

            {isLesson && script && (
              <ol className="mt-3 grid gap-1">
                {script.scenes.map((s, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      disabled={durationMs === null}
                      onClick={() => onChapter(i)}
                      data-testid={`card-chapter-${i}`}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60 disabled:hover:bg-transparent"
                    >
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-bold text-fg">{i + 1}</span>
                      <span className="truncate">{s.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Equalizer() {
  return (
    <span className="flex h-4 items-end gap-[3px]" aria-hidden>
      {[0, 0.2, 0.4].map((d) => (
        <span key={d} className="w-[3px] origin-bottom animate-eq rounded-full bg-white" style={{ animationDelay: `${d}s`, height: "100%" }} />
      ))}
    </span>
  );
}

function TypingBubble() {
  return (
    <div className="flex gap-2.5 animate-fade-up" data-testid="typing">
      <span className="btn-primary mt-0.5 grid size-7 shrink-0 place-items-center rounded-full">
        <Sparkles className="size-3.5" />
      </span>
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-3 text-sm text-muted">
        <span>Thinking and sketching an answer</span>
        <span className="flex gap-1" aria-hidden>
          {[0, 0.15, 0.3].map((d) => (
            <span key={d} className="size-1.5 animate-dots rounded-full bg-accent" style={{ animationDelay: `${d}s` }} />
          ))}
        </span>
      </div>
    </div>
  );
}

function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    if (await onSend(text)) setValue("");
  };

  const over = value.length > MAX_QUESTION;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface-2 p-1.5 transition-colors focus-within:border-accent/60 focus-within:bg-surface">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask a follow-up question…"
          aria-label="Ask a follow-up question"
          maxLength={MAX_QUESTION + 50}
          disabled={busy}
          data-testid="composer-input"
          className="max-h-[132px] min-h-9 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-faint disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !value.trim() || over}
          aria-label="Send question"
          data-testid="composer-send"
          className="btn-primary grid size-9 shrink-0 place-items-center rounded-xl"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
      {value.length > MAX_QUESTION - 100 && (
        <p className={cn("mt-1 px-1 text-right text-xs", over ? "text-danger" : "text-faint")}>
          {value.length}/{MAX_QUESTION}
        </p>
      )}
    </form>
  );
}
