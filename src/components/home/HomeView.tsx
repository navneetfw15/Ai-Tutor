"use client";

import { ArrowRight, Loader2, MessageCircleQuestion, Mic, PenTool, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Header } from "@/components/brand/Header";
import { api, ClientApiError } from "@/lib/client/api";
import type { LessonSummaryDTO } from "@/lib/lesson/dto";
import { cn, timeAgo } from "@/lib/utils";

const EXAMPLES = [
  "How do black holes form?",
  "Explain the Pythagorean theorem",
  "How does photosynthesis work?",
  "What causes inflation in an economy?",
  "How do vaccines train the immune system?",
  "Explain recursion in programming",
];

const STATUS = [
  "Planning the lesson…",
  "Choosing the clearest examples…",
  "Sketching the whiteboard…",
  "Timing drawings to the narration…",
  "Almost ready…",
];

export function HomeView() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [recent, setRecent] = useState<LessonSummaryDTO[]>([]);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .listLessons()
      .then((r) => setRecent(r.lessons.slice(0, 6)))
      .catch(() => undefined); // the list is a nicety; ignore failures
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [topic]);

  async function start(raw: string) {
    const text = raw.trim();
    if (text.length < 3 || busy) {
      if (text.length < 3) setError("Tell me a little more about what you'd like to learn.");
      return;
    }
    setBusy(true);
    setError(null);
    setRefusal(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await api.createLesson(text, controller.signal);
      if (controller.signal.aborted) return;
      if (res.refusal) {
        setRefusal(res.refusal);
        setBusy(false);
        return;
      }
      router.push(`/lesson/${res.lessonId}`);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  function cancel() {
    abort.current?.abort();
    setBusy(false);
  }

  return (
    <div className="ambient flex min-h-dvh flex-col">
      <Header showNew={false} />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-16 sm:px-6">
        {busy ? (
          <GeneratingView topic={topic.trim()} onCancel={cancel} />
        ) : (
          <>
            <section className="pt-12 text-center sm:pt-20">
              <p className="mx-auto mb-5 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-3 py-1 text-xs font-medium text-muted shadow-soft backdrop-blur animate-fade-up">
                <Sparkles className="size-3.5 text-accent" /> AI whiteboard tutor
              </p>
              <h1 className="text-balance text-4xl leading-[1.08] font-semibold tracking-tight animate-fade-up sm:text-6xl">
                Learn anything in <span className="gradient-text">two minutes.</span>
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-pretty text-base text-muted animate-fade-up sm:text-lg">
                Type a topic and watch it taught on a live whiteboard, with a friendly voice you can pause, rewind and question.
              </p>
            </section>

            <form
              className="mt-9 animate-fade-up"
              onSubmit={(e) => {
                e.preventDefault();
                void start(topic);
              }}
            >
              <div className="rounded-3xl border border-line bg-surface p-2.5 shadow-card transition-shadow focus-within:border-accent/50 focus-within:shadow-pop">
                <textarea
                  ref={inputRef}
                  value={topic}
                  rows={1}
                  autoFocus
                  maxLength={200}
                  onChange={(e) => {
                    setTopic(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void start(topic);
                    }
                  }}
                  placeholder="What would you like to learn today?"
                  aria-label="Topic to learn"
                  data-testid="topic-input"
                  className="max-h-40 min-h-[3.25rem] w-full resize-none bg-transparent px-3.5 py-3.5 text-base outline-none placeholder:text-faint sm:text-lg"
                />
                <div className="flex items-center justify-between gap-3 px-1.5 pb-0.5">
                  <span className="hidden pl-2 text-xs text-faint sm:inline">Press Enter to start · Shift+Enter for a new line</span>
                  <button
                    type="submit"
                    disabled={topic.trim().length < 3}
                    data-testid="start-lesson"
                    className="btn-primary ml-auto inline-flex h-11 items-center gap-2 rounded-2xl px-5 text-[15px] font-semibold"
                  >
                    Teach me <ArrowRight className="size-4" />
                  </button>
                </div>
              </div>

              {error && (
                <p className="mt-3 rounded-xl bg-danger-soft px-4 py-2.5 text-sm text-danger" role="alert" data-testid="home-error">
                  {error}
                </p>
              )}
              {refusal && (
                <p className="mt-3 rounded-xl bg-accent-soft px-4 py-2.5 text-sm text-fg" role="status" data-testid="home-refusal">
                  {refusal}
                </p>
              )}
            </form>

            <div className="mt-6 flex flex-wrap justify-center gap-2 animate-fade-up">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setTopic(ex);
                    void start(ex);
                  }}
                  className="rounded-full border border-line bg-surface/80 px-3.5 py-2 text-sm text-muted shadow-soft backdrop-blur transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:text-fg"
                >
                  {ex}
                </button>
              ))}
            </div>

            <ul className="mt-14 grid gap-3 sm:grid-cols-3">
              {[
                { icon: Mic, title: "Voice + board, in sync", text: "Every drawing appears exactly when it's spoken." },
                { icon: PenTool, title: "Pause, rewind, explore", text: "Scrub the timeline, zoom in, and add your own notes." },
                { icon: MessageCircleQuestion, title: "Ask anything", text: "Follow-up questions get their own mini-lesson." },
              ].map(({ icon: Icon, title, text }) => (
                <li key={title} className="rounded-2xl border border-line bg-surface/70 p-4 shadow-soft backdrop-blur">
                  <span className="mb-3 grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">
                    <Icon className="size-[18px]" />
                  </span>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="mt-1 text-sm text-muted">{text}</p>
                </li>
              ))}
            </ul>

            {recent.length > 0 && (
              <section className="mt-14" aria-labelledby="recent-h">
                <h2 id="recent-h" className="mb-3 text-sm font-semibold text-muted">
                  Continue learning
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {recent.map((l) => (
                    <li key={l.id}>
                      <Link
                        href={`/lesson/${l.id}`}
                        className="block rounded-2xl border border-line bg-surface p-4 shadow-soft transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-card"
                        data-testid="recent-lesson"
                      >
                        <p className="truncate text-sm font-semibold">{l.title}</p>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {l.topic} · {timeAgo(l.createdAt)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-faint">AI can make mistakes - double-check anything important.</footer>
    </div>
  );
}

function GeneratingView({ topic, onCancel }: { topic: string; onCancel: () => void }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const slow = seconds >= 45;
  const status = slow
    ? "The AI is busy right now - still working on it…"
    : seconds >= 28
      ? "Taking a little longer than usual…"
      : STATUS[Math.min(Math.floor(seconds / 6), STATUS.length - 1)];

  const paths = [
    "M60 150 C 120 60, 180 60, 230 140 S 330 220, 380 110",
    "M70 210 L 360 210",
    "M100 255 L 100 190 M 100 255 L 150 255",
  ];
  return (
    <section className="grid flex-1 place-items-center py-10 animate-fade-in" aria-live="polite" data-testid="generating">
      <div className="w-full max-w-md text-center">
        <div className="relative mx-auto aspect-[16/10] w-full overflow-hidden rounded-2xl border border-board-frame bg-[var(--board)] shadow-pop">
          <svg viewBox="0 0 440 290" className="size-full" fill="none" aria-hidden>
            <defs>
              <pattern id="gdots" width="22" height="22" patternUnits="userSpaceOnUse">
                <circle cx="11" cy="11" r="1.2" fill="#e7e0cc" />
              </pattern>
            </defs>
            <rect width="440" height="290" fill="url(#gdots)" />
            {paths.map((d, n) => (
              <path
                key={n}
                d={d}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1}
                stroke={["#5645ff", "#8b5cf6", "#ea7a0c"][n]}
                strokeWidth={6}
                strokeLinecap="round"
                style={{ animation: `draw 2.4s ease-in-out ${n * 0.7}s infinite alternate` }}
              />
            ))}
            <circle cx="380" cy="110" r="9" fill="#ef4444" className="animate-pulse" />
          </svg>
        </div>
        <p className="mt-7 flex items-center justify-center gap-2 text-lg font-semibold" data-testid="generating-status">
          <Loader2 className="size-5 animate-spin text-accent" />
          {status}
        </p>
        <p className="mx-auto mt-2 max-w-sm truncate text-sm text-muted">&ldquo;{topic}&rdquo;</p>
        <p className="mt-1 text-xs text-faint">Usually 20 to 45 seconds, longer when the AI is busy.</p>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "mt-6 inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium text-muted",
            "transition-colors hover:border-danger/50 hover:text-danger",
          )}
          data-testid="cancel-generation"
        >
          <X className="size-4" /> Cancel
        </button>
      </div>
    </section>
  );
}
