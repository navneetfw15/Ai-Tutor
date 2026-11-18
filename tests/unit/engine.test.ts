import { beforeEach, describe, expect, it } from "vitest";
import { buildTimeline } from "@/lib/lesson/timeline";
import type { Script, SceneTiming } from "@/lib/lesson/types";
import { PlaybackEngine, type AudioLike, type SpeechLike } from "@/lib/playback/engine";

class FakeAudio implements AudioLike {
  src = "";
  currentTime = 0;
  paused = true;
  ended = false;
  playbackRate = 1;
  volume = 1;
  muted = false;
  readyState = 4;
  preload = "";
  durationMs = 0;
  playCalls = 0;
  rejectPlay: string | null = null;
  private listeners = new Map<string, Set<() => void>>();
  play() {
    this.playCalls++;
    if (this.rejectPlay) return Promise.reject(new DOMException("blocked", this.rejectPlay));
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string) {
    this.listeners.get(type)?.forEach((fn) => fn());
  }
  /** Simulate real playback progressing by `ms`. */
  progress(ms: number, duration: number) {
    if (this.paused || this.ended) return;
    this.currentTime += (ms / 1000) * this.playbackRate;
    if (this.currentTime * 1000 >= duration) {
      this.currentTime = duration / 1000;
      this.ended = true;
      this.paused = true;
      this.emit("ended");
    }
  }
}

class FakeSpeech implements SpeechLike {
  spoken: { text: string; rate: number }[] = [];
  cancels = 0;
  handlers: { onStart(): void; onEnd(): void; onError(): void } | null = null;
  speak(text: string, opts: { rate: number; volume: number; onStart(): void; onEnd(): void; onError(): void }) {
    this.spoken.push({ text, rate: opts.rate });
    this.handlers = opts;
  }
  cancel() {
    this.cancels++;
  }
}

// Three scenes, 2000 / 1500 / 1000 ms of speech. Starts: 0, 2450, 4400. Duration 5800.
const SCENES = ["Alpha beta gamma delta.", "Epsilon zeta eta.", "Theta iota."];
const DURATIONS = [2000, 1500, 1000];
const timing = (text: string, durationMs: number): SceneTiming => {
  const words: SceneTiming["words"] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  const n = text.split(/\s+/).length;
  let i = 0;
  // Speech occupies [100, durationMs - 200]; the timeline adds 120ms of slack, so scene end == durationMs.
  const span = durationMs - 300;
  while ((m = re.exec(text))) {
    words.push([m.index, m.index + m[0].length, Math.round((i * span) / n) + 100, Math.round(((i + 1) * span) / n) + 100]);
    i++;
  }
  return { durationMs, words };
};

function makeTimeline() {
  const script: Script = {
    title: "T",
    summary: "",
    suggestions: [],
    scenes: SCENES.map((say, i) => ({ title: `S${i}`, clear: true, beats: [{ say, draw: [] }] })),
  };
  return buildTimeline(script, SCENES.map((t, i) => timing(t, DURATIONS[i])));
}

interface Rig {
  engine: PlaybackEngine;
  audios: FakeAudio[];
  speech: FakeSpeech;
  /** Advance wall-clock + audio by `ms` in 16ms frames. */
  run(ms: number): void;
  now: number;
}

function rig(mode: "audio" | "speech", opts: { noSpeech?: boolean } = {}): Rig {
  const audios: FakeAudio[] = [];
  const speech = new FakeSpeech();
  const state = { now: 1000 };
  const engine = new PlaybackEngine({
    createAudio: () => {
      const a = new FakeAudio();
      audios.push(a);
      return a;
    },
    speech: opts.noSpeech ? null : speech,
    raf: () => 1,
    caf: () => undefined,
    now: () => state.now,
  });
  const tl = makeTimeline();
  engine.load({ timeline: tl, mode, clipUrls: ["/a0.mp3", "/a1.mp3", "/a2.mp3"] });
  const r: Rig = {
    engine,
    audios,
    speech,
    get now() {
      return state.now;
    },
    run(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 16) {
        state.now += 16;
        for (const a of audios) {
          const sceneIdx = Number(/a(\d)/.exec(a.src)?.[1] ?? -1);
          if (sceneIdx >= 0) a.progress(16, DURATIONS[sceneIdx]);
        }
        engine.advance(state.now);
      }
    },
  };
  return r;
}

const active = (r: Rig) => r.audios.find((a) => !a.paused);

describe("PlaybackEngine - audio mode", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig("audio");
  });

  it("loads paused at 0 with the full duration", () => {
    const s = r.engine.getSnapshot();
    expect(s).toMatchObject({ loaded: true, time: 0, playing: false, scene: 0, ended: false });
    expect(s.duration).toBe(5800);
  });

  it("starts fetching the first scene's narration as soon as the lesson loads, so the first play does not wait", () => {
    const pre = r.audios.find((a) => a.src === "/a0.mp3");
    expect(pre).toBeDefined();
    expect(r.audios.every((a) => a.paused)).toBe(true); // fetched, but silent until play
    r.engine.play();
    r.run(100);
    expect(active(r)).toBe(pre); // the preloaded element is the one that plays
  });

  it("preloads the scene a lesson is resumed in, not scene 0", () => {
    r.engine.load({ timeline: makeTimeline(), mode: "audio", clipUrls: ["/a0.mp3", "/a1.mp3", "/a2.mp3"] }, 2600);
    expect(r.engine.getSnapshot().scene).toBe(1);
    expect(r.audios.some((a) => a.src === "/a1.mp3")).toBe(true);
    expect(r.audios.filter((a) => a.src === "/a0.mp3")).toHaveLength(0); // nothing wasted on scene 0
  });

  it("uses the audio element as the master clock", () => {
    r.engine.play();
    r.run(1000);
    const s = r.engine.getSnapshot();
    expect(s.playing).toBe(true);
    expect(active(r)!.src).toBe("/a0.mp3");
    // time must equal what the audio element reports, not wall time
    expect(s.time).toBeCloseTo(active(r)!.currentTime * 1000, 0);
    expect(s.time).toBeGreaterThan(900);
    expect(s.time).toBeLessThan(1100);
  });

  it("follows audio even when the clock and audio disagree (no drift)", () => {
    r.engine.play();
    r.run(500);
    active(r)!.currentTime += 0.3; // audio jumps ahead (e.g. after buffering)
    r.run(16);
    expect(r.engine.getSnapshot().time).toBeCloseTo(active(r)!.currentTime * 1000, 0);
  });

  it("moves through the gap into the next scene and starts its audio", () => {
    r.engine.play();
    r.run(2100); // scene 0 finished, in the gap
    expect(r.engine.getSnapshot().scene).toBe(0);
    expect(r.engine.getSnapshot().time).toBeGreaterThanOrEqual(2000);
    r.run(600); // gap (450ms) over
    const s = r.engine.getSnapshot();
    expect(s.scene).toBe(1);
    expect(active(r)!.src).toBe("/a1.mp3");
    expect(s.time).toBeGreaterThanOrEqual(2450);
  });

  it("preloads the next scene's audio into the idle element", () => {
    r.engine.play();
    r.run(100);
    expect(r.audios.some((a) => a.src === "/a1.mp3")).toBe(true);
  });

  it("pauses and resumes from the same position", () => {
    r.engine.play();
    r.run(800);
    r.engine.pause();
    const t = r.engine.getSnapshot().time;
    expect(r.engine.getSnapshot().playing).toBe(false);
    expect(r.audios.every((a) => a.paused)).toBe(true);
    r.run(1000); // time must not move while paused
    expect(r.engine.getSnapshot().time).toBe(t);
    r.engine.play();
    expect(active(r)!.currentTime * 1000).toBeCloseTo(t, -1);
    r.run(200);
    expect(r.engine.getSnapshot().time).toBeGreaterThan(t);
  });

  it("seeks into the middle of a later scene", () => {
    r.engine.seek(3000);
    expect(r.engine.getSnapshot()).toMatchObject({ time: 3000, scene: 1, playing: false });
    r.engine.play();
    expect(active(r)!.src).toBe("/a1.mp3");
    expect(active(r)!.currentTime).toBeCloseTo((3000 - 2450) / 1000, 2);
  });

  it("seeks while playing and keeps playing from the new place", () => {
    r.engine.play();
    r.run(400);
    r.engine.seek(4600);
    expect(r.engine.getSnapshot().scene).toBe(2);
    expect(active(r)!.src).toBe("/a2.mp3");
    expect(active(r)!.currentTime).toBeCloseTo((4600 - 4400) / 1000, 2);
    r.run(160);
    expect(r.engine.getSnapshot().time).toBeGreaterThan(4600);
  });

  it("seeking back to an already played scene replays it", () => {
    r.engine.play();
    r.run(3200); // into scene 1
    expect(r.engine.getSnapshot().scene).toBe(1);
    r.engine.seek(500);
    expect(r.engine.getSnapshot().scene).toBe(0);
    expect(active(r)!.src).toBe("/a0.mp3");
    expect(active(r)!.currentTime).toBeCloseTo(0.5, 2);
    r.run(160);
    expect(r.engine.getSnapshot().time).toBeLessThan(900);
  });

  it("seeking into a gap is silent, then continues with the next scene", () => {
    r.engine.seek(2200);
    r.engine.play();
    expect(active(r)).toBeUndefined();
    r.run(400);
    expect(r.engine.getSnapshot().scene).toBe(1);
    expect(active(r)!.src).toBe("/a1.mp3");
  });

  it("clamps seeks to the lesson bounds", () => {
    r.engine.seek(-500);
    expect(r.engine.getSnapshot().time).toBe(0);
    r.engine.seek(99999);
    expect(r.engine.getSnapshot()).toMatchObject({ time: 5800, ended: true });
  });

  it("plays to the end, stops, and replays from the start", () => {
    r.engine.play();
    r.run(7000);
    let s = r.engine.getSnapshot();
    expect(s).toMatchObject({ playing: false, ended: true, time: 5800, scene: 2 });
    r.engine.play(); // pressing play at the end restarts
    r.run(100);
    s = r.engine.getSnapshot();
    expect(s.ended).toBe(false);
    expect(s.playing).toBe(true);
    expect(s.time).toBeLessThan(500);
    expect(s.scene).toBe(0);
  });

  it("restart returns to 0 and keeps playing if it was playing", () => {
    r.engine.play();
    r.run(3000);
    r.engine.restart();
    expect(r.engine.getSnapshot()).toMatchObject({ time: 0, scene: 0, playing: true });
    expect(active(r)!.src).toBe("/a0.mp3");
    r.engine.pause();
    r.engine.seek(3000);
    r.engine.restart();
    expect(r.engine.getSnapshot()).toMatchObject({ time: 0, playing: false });
  });

  it("seekBy and seekToScene", () => {
    r.engine.seek(1000);
    r.engine.seekBy(-5000);
    expect(r.engine.getSnapshot().time).toBe(0);
    r.engine.seekBy(5000);
    expect(r.engine.getSnapshot().time).toBe(5000);
    r.engine.seekToScene(1);
    expect(r.engine.getSnapshot().time).toBe(2450);
  });

  it("applies playback rate to audio and to the silent gaps", () => {
    r.engine.setRate(2);
    expect(r.audios.every((a) => a.playbackRate === 2)).toBe(true);
    r.engine.seek(2100); // in the gap
    r.engine.play();
    r.run(176); // 176ms * 2 = 352ms < 350 gap remaining? gap ends at 2450 -> 350ms away
    expect(r.engine.getSnapshot().scene).toBe(1);
  });

  it("reports blocked autoplay instead of pretending to play", async () => {
    r.engine.load({ timeline: makeTimeline(), mode: "audio", clipUrls: ["/a0.mp3", "/a1.mp3", "/a2.mp3"] });
    r.audios.forEach((a) => (a.rejectPlay = "NotAllowedError"));
    r.engine.play();
    await Promise.resolve();
    await Promise.resolve();
    const s = r.engine.getSnapshot();
    expect(s.blocked).toBe(true);
    expect(s.playing).toBe(false);
  });

  it("ignores AbortError from a play() interrupted by a seek", async () => {
    r.audios.forEach((a) => (a.rejectPlay = "AbortError"));
    r.engine.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.engine.getSnapshot().blocked).toBe(false);
    expect(r.engine.getSnapshot().playing).toBe(true);
  });

  it("keeps the lesson moving if a scene's audio errors out", () => {
    r.engine.play();
    r.run(200);
    active(r)!.emit("error");
    r.run(2400); // the rest of scene 0 plays on the wall clock
    expect(r.engine.getSnapshot().scene).toBeGreaterThanOrEqual(1);
  });

  it("plays silently when a scene has no clip", () => {
    r.engine.load({ timeline: makeTimeline(), mode: "audio", clipUrls: ["/a0.mp3", null, "/a2.mp3"] });
    r.engine.seek(2450);
    r.engine.play();
    expect(active(r)).toBeUndefined();
    r.run(2100); // 1500ms of scene 1 on the wall clock + 450ms gap
    expect(r.engine.getSnapshot().scene).toBe(2);
  });

  it("mute and volume reach the audio elements", () => {
    r.engine.setMuted(true);
    r.engine.setVolume(0.4);
    expect(r.audios.every((a) => a.muted && a.volume === 0.4)).toBe(true);
    expect(r.engine.getSnapshot()).toMatchObject({ muted: true, volume: 0.4 });
  });

  it("notifies subscribers and supports unsubscribe", () => {
    let calls = 0;
    const off = r.engine.subscribe(() => calls++);
    r.engine.play();
    r.run(100);
    expect(calls).toBeGreaterThan(3);
    off();
    const before = calls;
    r.run(100);
    expect(calls).toBe(before);
  });
});

describe("PlaybackEngine - speech mode", () => {
  it("is driven by the wall clock and speaks each scene", () => {
    const r = rig("speech");
    r.engine.play();
    expect(r.speech.spoken[0].text).toBe("Alpha beta gamma delta.");
    r.speech.handlers!.onStart();
    r.run(1000);
    expect(r.engine.getSnapshot().time).toBeGreaterThan(900);
    expect(r.engine.getSnapshot().time).toBeLessThan(1100);
  });

  it("moves on when speech ends early and waits briefly when it runs long", () => {
    const r = rig("speech");
    r.engine.play();
    r.speech.handlers!.onStart();
    r.run(2000); // clock reaches scene end but speech is still going
    expect(r.engine.getSnapshot().time).toBeLessThanOrEqual(2000 + 20);
    expect(r.engine.getSnapshot().scene).toBe(0);
    r.speech.handlers!.onEnd();
    r.run(700);
    expect(r.engine.getSnapshot().scene).toBe(1);
  });

  it("speaks the remainder of a scene after a seek", () => {
    const r = rig("speech");
    r.engine.seek(1400); // 'gamma' / 'delta' region of scene 0
    r.engine.play();
    expect(r.speech.spoken.at(-1)!.text).toBe("delta.");
  });

  it("cancels speech on pause and does not speak while muted", () => {
    const r = rig("speech");
    r.engine.play();
    const before = r.speech.cancels;
    r.engine.pause();
    expect(r.speech.cancels).toBeGreaterThan(before);
    const spokenBefore = r.speech.spoken.length;
    r.engine.setMuted(true);
    r.engine.play();
    expect(r.speech.spoken.length).toBe(spokenBefore);
    r.run(2600);
    expect(r.engine.getSnapshot().scene).toBe(1); // captions-only playback still advances
  });

  it("does not stall when speech never starts", () => {
    const r = rig("speech");
    r.engine.play(); // no onStart ever fires
    r.run(2000); // scene 0's nominal length: the engine must not hold for the 3s end-of-speech grace
    r.run(600); // + gap
    expect(r.engine.getSnapshot().scene).toBe(1);
  });

  it("works without any speech support (captions only)", () => {
    const r = rig("speech", { noSpeech: true });
    r.engine.play();
    r.run(3000);
    expect(r.engine.getSnapshot().scene).toBe(1);
  });

  it("restarts speech at the new rate when the speed changes mid-scene", () => {
    const r = rig("speech");
    r.engine.play();
    r.run(800);
    r.engine.setRate(1.5);
    expect(r.speech.spoken.at(-1)!.rate).toBe(1.5);
  });
});
