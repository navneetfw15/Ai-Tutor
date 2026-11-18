import { sceneIndexAt, type Timeline } from "@/lib/lesson/timeline";

/**
 * Playback engine: owns the lesson clock and keeps voice + whiteboard in sync.
 *
 * - The whiteboard is a pure function of `time` (see `boardAt`), so seeking is exact.
 * - "audio" mode: each scene is an MP3; while a scene is speaking the audio element is the master
 *   clock (time = sceneStart + audio.currentTime) so drawing can never drift from the voice.
 * - "speech" mode: the browser's speech synthesis speaks the scene while a wall clock drives time.
 * - Between scenes there is a short silent gap driven by the wall clock.
 *
 * The engine is framework-free and takes its browser dependencies by injection, so it can be unit
 * tested without a DOM.
 */

export interface AudioLike {
  src: string;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  readyState: number;
  preload: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SpeechHandlers {
  onStart(): void;
  onEnd(): void;
  onError(): void;
}

export interface SpeechLike {
  speak(text: string, opts: { rate: number; volume: number } & SpeechHandlers): void;
  cancel(): void;
}

export interface EngineDeps {
  createAudio?: () => AudioLike;
  speech?: SpeechLike | null;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

export interface EngineSource {
  timeline: Timeline;
  /** MP3 url per scene (audio mode). A missing url means that scene plays silently. */
  clipUrls: (string | null)[];
  mode: "audio" | "speech";
}

export interface EngineState {
  loaded: boolean;
  time: number;
  duration: number;
  playing: boolean;
  /** Waiting for audio data. */
  buffering: boolean;
  ended: boolean;
  scene: number;
  rate: number;
  muted: boolean;
  volume: number;
  /** The browser refused to start audio (autoplay policy); the user must press play again. */
  blocked: boolean;
}

type Phase = "speaking" | "gap";

/** How long to wait past a scene's nominal end for its voice to finish before moving on anyway. */
const AUDIO_END_GRACE_MS = 800;
const SPEECH_END_GRACE_MS = 3000;
const SPEECH_START_TIMEOUT_MS = 1500;
/** Give up on audio that never starts. */
const AUDIO_START_TIMEOUT_MS = 7000;

export class PlaybackEngine {
  private deps: Required<Omit<EngineDeps, "speech" | "createAudio">> & Pick<EngineDeps, "speech" | "createAudio">;
  private source: EngineSource | null = null;
  private t = 0;
  private playing = false;
  private buffering = false;
  private ended = false;
  private blocked = false;
  private scene = 0;
  private phase: Phase = "speaking";
  private voiceDone = false;
  private silentScene = false;
  private speechStarted = false;
  private voiceStartedAt = 0;
  private rate = 1;
  private muted = false;
  private volume = 1;
  private lastNow = 0;
  private rafId: number | null = null;
  private audios: AudioLike[] = [];
  /** Scene index loaded into each audio slot (-1 = none). */
  private loadedScene: number[] = [-1, -1];
  private active = 0;
  private listeners = new Set<() => void>();
  private snapshot: EngineState;
  private audioCleanups: (() => void)[] = [];
  private speechToken = 0;

  constructor(deps: EngineDeps = {}) {
    this.deps = {
      raf: deps.raf ?? ((cb) => requestAnimationFrame(cb)),
      caf: deps.caf ?? ((id) => cancelAnimationFrame(id)),
      now: deps.now ?? (() => performance.now()),
      speech: deps.speech,
      createAudio: deps.createAudio ?? (() => new Audio() as unknown as AudioLike),
    };
    this.snapshot = this.buildSnapshot();
  }

  // ---- subscription (compatible with useSyncExternalStore) ----------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EngineState => this.snapshot;

  private buildSnapshot(): EngineState {
    return {
      loaded: !!this.source,
      time: this.t,
      duration: this.source?.timeline.duration ?? 0,
      playing: this.playing,
      buffering: this.buffering,
      ended: this.ended,
      scene: this.scene,
      rate: this.rate,
      muted: this.muted,
      volume: this.volume,
      blocked: this.blocked,
    };
  }

  private emit() {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }

  // ---- public controls ----------------------------------------------------------------------

  /** Load a lesson. Playback stays paused at `startTime`. */
  load(source: EngineSource, startTime = 0) {
    this.stopVoice();
    this.teardownAudio();
    this.source = source;
    this.playing = false;
    this.buffering = false;
    this.blocked = false;
    this.cancelLoop();
    if (source.mode === "audio") this.ensureAudio();
    this.setTime(startTime);
    // Start fetching the narration now: by the time the learner presses play it is already buffered,
    // instead of the first play waiting for a network round trip.
    if (source.mode === "audio") this.preloadInto(this.active, this.phase === "speaking" ? this.scene : this.scene + 1);
    this.emit();
  }

  unload() {
    this.pause();
    this.stopVoice();
    this.teardownAudio();
    this.source = null;
    this.t = 0;
    this.scene = 0;
    this.ended = false;
    this.emit();
  }

  play() {
    const src = this.source;
    if (!src || src.timeline.scenes.length === 0) return;
    if (this.ended || this.t >= src.timeline.duration - 40) this.setTime(0);
    this.playing = true;
    this.ended = false;
    this.blocked = false;
    this.lastNow = this.deps.now();
    if (this.phase === "speaking") this.startVoice(this.scene, this.t - src.timeline.scenes[this.scene].start);
    this.startLoop();
    this.emit();
  }

  pause() {
    if (!this.playing && !this.buffering) return;
    this.playing = false;
    this.buffering = false;
    this.cancelLoop();
    this.stopVoice();
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  restart() {
    const wasPlaying = this.playing;
    this.stopVoice();
    this.setTime(0);
    if (wasPlaying) this.play();
    else this.emit();
  }

  seek(ms: number) {
    if (!this.source) return;
    this.stopVoice();
    this.setTime(ms);
    if (this.playing) {
      this.lastNow = this.deps.now();
      if (this.phase === "speaking") {
        this.startVoice(this.scene, this.t - this.source.timeline.scenes[this.scene].start);
      }
    }
    this.emit();
  }

  seekBy(deltaMs: number) {
    this.seek(this.t + deltaMs);
  }

  seekToScene(index: number) {
    const sc = this.source?.timeline.scenes[index];
    if (sc) this.seek(sc.start);
  }

  setRate(rate: number) {
    this.rate = rate;
    for (const a of this.audios) a.playbackRate = rate;
    // Speech cannot change speed mid-utterance: restart the scene's speech from the current word.
    if (this.playing && this.source?.mode === "speech" && this.phase === "speaking") {
      this.stopVoice();
      this.startVoice(this.scene, this.t - this.source.timeline.scenes[this.scene].start);
    }
    this.emit();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const a of this.audios) a.muted = muted;
    if (muted && this.source?.mode === "speech") this.deps.speech?.cancel();
    else if (!muted && this.playing && this.source?.mode === "speech" && this.phase === "speaking") {
      this.startVoice(this.scene, this.t - this.source.timeline.scenes[this.scene].start);
    }
    this.emit();
  }

  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume));
    for (const a of this.audios) a.volume = this.volume;
    this.emit();
  }

  destroy() {
    this.cancelLoop();
    this.stopVoice();
    this.teardownAudio();
    this.listeners.clear();
  }

  // ---- internals ----------------------------------------------------------------------------

  /** Place the clock at `ms`, deriving scene and phase. Does not start any voice. */
  private setTime(ms: number) {
    const tl = this.source?.timeline;
    if (!tl || tl.scenes.length === 0) {
      this.t = 0;
      return;
    }
    this.t = Math.min(tl.duration, Math.max(0, ms));
    this.scene = sceneIndexAt(tl, this.t);
    const sc = tl.scenes[this.scene];
    this.phase = this.t <= sc.end ? "speaking" : "gap";
    this.voiceDone = this.phase === "gap";
    this.silentScene = false;
    this.ended = this.t >= tl.duration;
  }

  private startLoop() {
    if (this.rafId !== null) return;
    const step = (now: number) => {
      this.rafId = null;
      if (!this.playing) return;
      this.advance(now);
      if (this.playing) this.rafId = this.deps.raf(step);
    };
    this.rafId = this.deps.raf(step);
  }

  private cancelLoop() {
    if (this.rafId !== null) {
      this.deps.caf(this.rafId);
      this.rafId = null;
    }
  }

  /** One clock step. Public so tests can drive time deterministically. */
  advance(now: number) {
    const src = this.source;
    if (!src || !this.playing) return;
    const tl = src.timeline;
    const dt = Math.min(Math.max(0, now - this.lastNow), 120) * this.rate;
    this.lastNow = now;
    const sc = tl.scenes[this.scene];

    if (this.phase === "speaking") {
      const audio = src.mode === "audio" && !this.silentScene ? this.audios[this.active] : null;
      if (audio && this.loadedScene[this.active] === this.scene) {
        if (audio.ended) {
          this.voiceDone = true;
        } else if (!audio.paused && audio.readyState >= 2) {
          this.buffering = false;
          this.t = sc.start + audio.currentTime * 1000;
        } else if (!this.blocked) {
          // Started but not playing: waiting for data.
          this.buffering = true;
          if (now - this.voiceStartedAt > AUDIO_START_TIMEOUT_MS && audio.currentTime === 0) {
            this.silentScene = true; // give up on this scene's audio; keep the lesson moving
            this.buffering = false;
          }
        }
      } else {
        this.buffering = false;
        this.t += dt;
        // Speech that never starts (no voices installed, blocked by the browser) must not stall us.
        if (src.mode === "speech" && !this.speechStarted && !this.silentScene && now - this.voiceStartedAt > SPEECH_START_TIMEOUT_MS) {
          this.silentScene = true;
        }
      }

      if (this.t >= sc.end) {
        const grace = src.mode === "speech" ? SPEECH_END_GRACE_MS : AUDIO_END_GRACE_MS;
        if (this.voiceDone || this.silentScene || this.t >= sc.end + grace) {
          this.t = Math.max(this.t, sc.end);
          this.phase = "gap";
          this.stopVoice();
        } else {
          this.t = sc.end; // hold until the voice finishes
        }
      } else if (this.voiceDone) {
        // The voice finished before the nominal scene end: skip ahead.
        this.t = sc.end;
        this.phase = "gap";
        this.stopVoice();
      }
    } else {
      this.t += dt;
    }

    if (this.phase === "gap") {
      const next = tl.scenes[this.scene + 1];
      if (next) {
        if (this.t >= next.start) {
          this.scene += 1;
          this.phase = "speaking";
          this.voiceDone = false;
          this.silentScene = false;
          this.t = next.start;
          this.startVoice(this.scene, 0);
        }
      } else if (this.t >= tl.duration) {
        this.t = tl.duration;
        this.playing = false;
        this.ended = true;
        this.buffering = false;
        this.stopVoice();
      }
    }
    this.emit();
  }

  // ---- voice --------------------------------------------------------------------------------

  private ensureAudio() {
    if (this.audios.length) return;
    for (let i = 0; i < 2; i++) {
      const a = this.deps.createAudio!();
      a.preload = "auto";
      a.volume = this.volume;
      a.muted = this.muted;
      a.playbackRate = this.rate;
      const onEnded = () => {
        if (this.audios[this.active] === a && this.phase === "speaking") this.voiceDone = true;
      };
      const onError = () => {
        if (this.audios[this.active] === a) this.silentScene = true;
      };
      a.addEventListener("ended", onEnded);
      a.addEventListener("error", onError);
      this.audioCleanups.push(() => {
        a.removeEventListener("ended", onEnded);
        a.removeEventListener("error", onError);
        a.pause();
        a.src = "";
      });
      this.audios.push(a);
    }
    this.loadedScene = [-1, -1];
    this.active = 0;
  }

  private teardownAudio() {
    for (const cleanup of this.audioCleanups) cleanup();
    this.audioCleanups = [];
    this.audios = [];
    this.loadedScene = [-1, -1];
  }

  private startVoice(sceneIndex: number, offsetMs: number) {
    const src = this.source;
    if (!src) return;
    this.voiceDone = false;
    this.silentScene = false;
    this.speechStarted = false;
    this.voiceStartedAt = this.deps.now();
    const scene = src.timeline.scenes[sceneIndex];

    if (src.mode === "speech") {
      if (this.muted || !this.deps.speech) {
        this.silentScene = true; // clock-driven, captions only
        return;
      }
      // Speak from the word being spoken at `offsetMs`.
      const absolute = scene.start + offsetMs;
      let from = scene.words.findIndex((w) => w.end > absolute);
      if (from < 0) from = scene.words.length;
      const text = scene.text.slice(scene.words[from]?.c0 ?? scene.text.length).trim();
      if (!text) {
        this.voiceDone = true;
        return;
      }
      const token = ++this.speechToken;
      this.deps.speech.speak(text, {
        rate: this.rate,
        volume: this.volume,
        onStart: () => {
          if (token === this.speechToken) this.speechStarted = true;
        },
        onEnd: () => {
          if (token === this.speechToken && this.phase === "speaking") this.voiceDone = true;
        },
        onError: () => {
          if (token === this.speechToken) this.silentScene = true;
        },
      });
      return;
    }

    const url = src.clipUrls[sceneIndex];
    if (!url) {
      this.silentScene = true;
      return;
    }
    // Use the slot that already holds this scene (preloaded) if there is one.
    let slot = this.loadedScene.indexOf(sceneIndex);
    if (slot < 0) {
      slot = 1 - this.active;
      if (this.loadedScene[this.active] === -1) slot = this.active;
      this.audios[slot].src = url;
      this.loadedScene[slot] = sceneIndex;
    }
    const other = 1 - slot;
    this.audios[other].pause();
    this.active = slot;
    const audio = this.audios[slot];
    audio.playbackRate = this.rate;
    audio.muted = this.muted;
    audio.volume = this.volume;
    try {
      audio.currentTime = Math.max(0, offsetMs) / 1000;
    } catch {
      /* metadata not loaded yet; the browser applies the start position when it is */
    }
    this.buffering = audio.readyState < 3;
    audio
      .play()
      .then(() => {
        this.blocked = false;
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return; // interrupted by a seek
        // Autoplay policy (NotAllowedError) or unsupported source.
        if (this.audios[this.active] === audio) {
          this.blocked = true;
          this.buffering = false;
          this.playing = false;
          this.cancelLoop();
          this.emit();
        }
      });
    this.preloadNext(sceneIndex + 1);
  }

  private preloadNext(sceneIndex: number) {
    this.preloadInto(1 - this.active, sceneIndex);
  }

  /** Point an audio element at a scene's clip and let the browser start buffering it. */
  private preloadInto(slot: number, sceneIndex: number) {
    const url = this.source?.clipUrls[sceneIndex];
    if (!url || this.source?.mode !== "audio") return;
    if (this.loadedScene.includes(sceneIndex)) return;
    const audio = this.audios[slot];
    audio.pause();
    audio.src = url;
    audio.preload = "auto";
    audio.load();
    this.loadedScene[slot] = sceneIndex;
  }

  private stopVoice() {
    this.speechToken++;
    this.deps.speech?.cancel();
    for (const a of this.audios) a.pause();
  }
}

/** Browser speech synthesis wrapper with sentence chunking (avoids Chrome's ~15s cutoff bug). */
export function createBrowserSpeech(): SpeechLike | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const synth = window.speechSynthesis;
  // Keep references so utterances are not garbage collected mid-speech (a known Chrome bug).
  const live = new Set<SpeechSynthesisUtterance>();

  const pickVoice = (): SpeechSynthesisVoice | undefined => {
    const voices = synth.getVoices().filter((v) => /^en/i.test(v.lang));
    const preferred = ["Natural", "Samantha", "Google US English", "Aria", "Jenny", "Daniel", "Zira"];
    for (const name of preferred) {
      const hit = voices.find((v) => v.name.includes(name));
      if (hit) return hit;
    }
    return voices.find((v) => v.localService) ?? voices[0];
  };

  return {
    speak(text, { rate, volume, onStart, onEnd, onError }) {
      synth.cancel();
      const chunks = text.match(/[^.!?]+[.!?]*\s*/g)?.map((c) => c.trim()).filter(Boolean) ?? [text];
      const voice = pickVoice();
      chunks.forEach((chunk, i) => {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) u.voice = voice;
        u.rate = rate;
        u.volume = volume;
        u.lang = voice?.lang ?? "en-US";
        if (i === 0) u.onstart = onStart;
        u.onend = () => {
          live.delete(u);
          if (i === chunks.length - 1) onEnd();
        };
        u.onerror = (e) => {
          live.delete(u);
          if (e.error !== "canceled" && e.error !== "interrupted") onError();
        };
        live.add(u);
        synth.speak(u);
      });
    },
    cancel() {
      live.clear();
      synth.cancel();
    },
  };
}
