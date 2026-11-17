"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LessonDTO, MessageDTO } from "@/lib/lesson/dto";
import { estimateSceneTiming } from "@/lib/lesson/estimate";
import { buildTimeline, sceneIndexAt, speechAt, type Timeline } from "@/lib/lesson/timeline";
import { sceneText, type SceneTiming } from "@/lib/lesson/types";
import { PlaybackEngine, createBrowserSpeech, type EngineSource } from "@/lib/playback/engine";
import { ClientApiError, api } from "./api";
import { AudioPreparer } from "./audioPreparer";

export interface Playable {
  message: MessageDTO;
  timeline: Timeline;
  source: EngineSource;
}

export interface AudioProgress {
  done: number;
  total: number;
  status: "preparing" | "ready" | "failed";
  error?: string;
}

export interface LoadError {
  message: string;
  notFound: boolean;
}

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function buildPlayable(m: MessageDTO): Playable | null {
  const script = m.script;
  if (!script || script.scenes.length === 0) return null;
  const mode = m.voiceMode === "eleven" ? "audio" : "speech";
  const clipByScene = new Map(m.clips.map((c) => [c.sceneIndex, c]));
  if (mode === "audio" && script.scenes.some((_, i) => !clipByScene.has(i))) return null; // still recording

  const timings: SceneTiming[] = script.scenes.map((scene, i) => {
    if (mode === "audio") {
      const clip = clipByScene.get(i)!;
      return { durationMs: clip.durationMs, words: clip.words };
    }
    return estimateSceneTiming(sceneText(scene));
  });
  const timeline = buildTimeline(script, timings);
  return {
    message: m,
    timeline,
    source: {
      timeline,
      mode,
      clipUrls: script.scenes.map((_, i) => (mode === "audio" ? clipByScene.get(i)!.url : null)),
    },
  };
}

/** Messages are replaced immutably, so their identity is a perfect cache key for built playables. */
const playableCache = new WeakMap<MessageDTO, Playable | null>();
function playableFor(m: MessageDTO): Playable | null {
  if (!playableCache.has(m)) playableCache.set(m, buildPlayable(m));
  return playableCache.get(m)!;
}

/**
 * Controller for the lesson workspace: loads the lesson, records narration audio (with retries and
 * a browser-voice fallback), builds playback timelines, drives the engine and runs the follow-up
 * conversation.
 */
export function useTutor(lessonId: string) {
  const [engine] = useState(() => new PlaybackEngine({ speech: createBrowserSpeech() }));
  useEffect(() => () => engine.destroy(), [engine]);

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [lesson, setLesson] = useState<LessonDTO | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [audioErrors, setAudioErrors] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [resume, setResume] = useState<{ id: string; time: number } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const pendingPlay = useRef(false);
  const pendingStart = useRef<number | null>(null);

  // ---- load the lesson (the page remounts this hook per lesson via `key`) ------------------

  useEffect(() => {
    let cancelled = false;
    api
      .getLesson(lessonId)
      .then(({ lesson }) => {
        if (cancelled) return;
        // Only the owner can have narration recorded; for anyone else a not-yet-recorded message is
        // narrated by the browser (avoids requests that are certain to be refused).
        const messages = lesson.isOwner
          ? lesson.messages
          : lesson.messages.map((m) =>
              m.script && m.clips.length < m.script.scenes.length ? { ...m, voiceMode: "browser" as const } : m,
            );
        setLesson(lesson);
        setMessages(messages);
        setActiveId(lesson.messages.find((m) => m.script && m.script.scenes.length > 0)?.id ?? null);
        setPhase("ready");
        document.title = `${lesson.title} | Whiteboard Tutor`;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err instanceof ClientApiError ? err : null;
        setLoadError({ message: e?.message ?? "Could not load this lesson.", notFound: e?.status === 404 });
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId, reloadTick]);

  const reload = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    setReloadTick((n) => n + 1);
  }, []);

  // ---- narration audio --------------------------------------------------------------------

  const patchMessage = useCallback((id: string, patch: (m: MessageDTO) => MessageDTO) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  const switchToBrowserVoice = useCallback(
    (id: string) => {
      setAudioErrors((prev) => omit(prev, id));
      patchMessage(id, (m) => ({ ...m, voiceMode: "browser" }));
    },
    [patchMessage],
  );

  const [preparer] = useState(
    () =>
      new AudioPreparer(
        {
          onClip: (id, clip) =>
            patchMessage(id, (x) => ({ ...x, clips: [...x.clips.filter((c) => c.sceneIndex !== clip.sceneIndex), clip] })),
          onFallback: (id) => patchMessage(id, (x) => ({ ...x, voiceMode: "browser" })),
          onFailure: (id, message) => setAudioErrors((prev) => ({ ...prev, [id]: message })),
        },
        api.audio,
      ),
  );

  useEffect(() => {
    if (phase !== "ready") return;
    for (const m of messages) {
      if (m.role !== "assistant" || !m.script || m.voiceMode !== "eleven" || audioErrors[m.id]) continue;
      if (m.clips.length < m.script.scenes.length) void preparer.ensure(m);
    }
  }, [messages, phase, preparer, audioErrors]);

  const retryAudio = useCallback((id: string) => {
    // Clearing the error re-triggers the effect above.
    setAudioErrors((prev) => omit(prev, id));
  }, []);

  /** Recording progress per message, derived from what has been stored so far. */
  const audio = useMemo(() => {
    const out: Record<string, AudioProgress> = {};
    for (const m of messages) {
      if (m.role !== "assistant" || !m.script || m.script.scenes.length === 0) continue;
      const total = m.script.scenes.length;
      const done = m.voiceMode === "eleven" ? Math.min(m.clips.length, total) : total;
      const error = audioErrors[m.id];
      out[m.id] = { done, total, status: error ? "failed" : done >= total ? "ready" : "preparing", error };
    }
    return out;
  }, [messages, audioErrors]);

  // ---- playables --------------------------------------------------------------------------

  const playables = useMemo(() => {
    const out: Record<string, Playable | null> = {};
    for (const m of messages) if (m.script) out[m.id] = playableFor(m);
    return out;
  }, [messages]);

  const lessonMessage = useMemo(() => messages.find((m) => m.script && m.script.scenes.length > 0) ?? null, [messages]);
  const active = activeId ? (playables[activeId] ?? null) : null;

  // Load the active playable into the engine whenever it (or its audio) changes.
  useEffect(() => {
    if (!active) {
      engine.unload();
      return;
    }
    engine.load(active.source, pendingStart.current ?? 0);
    const autoplay = pendingPlay.current;
    pendingStart.current = null;
    pendingPlay.current = false;
    if (autoplay) engine.play();
  }, [active, engine]);

  const playMessage = useCallback(
    (id: string, opts: { from?: number; autoplay?: boolean } = {}) => {
      const { from = 0, autoplay = true } = opts;
      if (id === activeId && playables[id]) {
        engine.seek(from);
        if (autoplay) engine.play();
        return;
      }
      pendingStart.current = from;
      pendingPlay.current = autoplay;
      setActiveId(id);
    },
    [activeId, engine, playables],
  );

  const resumeLesson = useCallback(() => {
    if (!resume) return;
    const target = resume;
    setResume(null);
    playMessage(target.id, { from: target.time, autoplay: true });
  }, [resume, playMessage]);

  // ---- follow-up questions ----------------------------------------------------------------

  const ask = useCallback(
    async (text: string): Promise<boolean> => {
      const question = text.trim();
      if (!question || asking || !lesson) return false;
      engine.pause();
      const snap = engine.getSnapshot();

      // Where in the lesson was the learner, and what had they just heard?
      let sceneIndex = 0;
      let spokenSoFar: string | undefined;
      const lessonPlayable = lessonMessage ? playables[lessonMessage.id] : null;
      const watchingLesson = !!active && !!lessonMessage && active.message.id === lessonMessage.id;
      if (watchingLesson && active) {
        sceneIndex = snap.scene;
        const pos = speechAt(active.timeline, snap.time);
        const beat = active.timeline.scenes[pos.scene]?.beats[pos.beat];
        spokenSoFar = beat?.text.slice(0, 380);
      } else if (resume && lessonPlayable) {
        sceneIndex = sceneIndexAt(lessonPlayable.timeline, resume.time);
      }

      setAsking(true);
      setAskError(null);
      const tempId = `tmp-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: tempId, role: "user", text: question, script: null, suggestions: [], voiceMode: "browser", clips: [], createdAt: new Date().toISOString() },
      ]);
      try {
        const { user, assistant } = await api.ask(lessonId, { text: question, sceneIndex, spokenSoFar });
        setMessages((prev) => [...prev.filter((m) => m.id !== tempId), user, assistant]);
        if (assistant.script && assistant.script.scenes.length > 0) {
          // Remember where the lesson was so the learner can pick it up again afterwards.
          if (watchingLesson && lessonMessage) setResume({ id: lessonMessage.id, time: snap.time });
          pendingStart.current = 0;
          pendingPlay.current = true;
          setActiveId(assistant.id);
        }
        return true;
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setAskError(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
        return false;
      } finally {
        setAsking(false);
      }
    },
    [active, asking, engine, lesson, lessonId, lessonMessage, playables, resume],
  );

  return {
    engine,
    phase,
    loadError,
    reload,
    lesson,
    messages,
    audio,
    active,
    activeId,
    lessonMessage,
    playables,
    asking,
    askError,
    clearAskError: () => setAskError(null),
    resume,
    resumeLesson,
    playMessage,
    ask,
    retryAudio,
    switchToBrowserVoice,
  };
}
