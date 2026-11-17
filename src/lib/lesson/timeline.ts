import { estimateSceneTiming } from "./estimate";
import { actionRect, clamp, hashString, rectCenter, type Rect } from "./geometry";
import { beatOffsets, sceneText, type Action, type Script, type SceneTiming } from "./types";

/** Silence between scenes: lets the board clear and the next page appear. */
export const SCENE_GAP_MS = 450;
/** How long the previous board takes to fade when a scene starts on a clean page. */
export const BOARD_FADE_MS = 320;
const ERASE_MS = 450;
const TAIL_MS = 400;

export interface TimedItem {
  key: string;
  scene: number;
  action: Action;
  start: number;
  dur: number;
  /** Absolute time at which an `erase` action removes this element. */
  erasedAt?: number;
  /** The element's own bounding box. */
  rect: Rect | null;
  /** For highlights: bounding box of the highlighted element. */
  targetRect?: Rect;
  layer: number;
  seed: number;
}

export interface TimelineWord {
  text: string;
  c0: number;
  c1: number;
  start: number;
  end: number;
}

export interface TimelineBeat {
  text: string;
  start: number;
  end: number;
  /** Index range into the scene's `words`. */
  w0: number;
  w1: number;
}

export interface TimelineScene {
  index: number;
  title: string;
  start: number;
  end: number;
  /** Index of the first scene of the board this scene is drawn on. */
  board: number;
  clear: boolean;
  text: string;
  words: TimelineWord[];
  beats: TimelineBeat[];
}

export interface Timeline {
  duration: number;
  scenes: TimelineScene[];
  itemsByScene: TimedItem[][];
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Find the word of a beat where a cue phrase is spoken. */
function findCue(cue: string, words: TimelineWord[]): TimelineWord | undefined {
  const cueTokens = cue.split(/\s+/).map(norm).filter(Boolean);
  if (cueTokens.length === 0 || words.length === 0) return undefined;
  const tokens = words.map((w) => norm(w.text));

  for (let i = 0; i < tokens.length; i++) {
    if (cueTokens.every((t, j) => tokens[i + j] === t)) return words[i];
  }
  // Stem-ish match on the first cue token ("photosynth" ~ "photosynthesis").
  const first = cueTokens[0];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok && Math.min(tok.length, first.length) >= 4 && (tok.startsWith(first) || first.startsWith(tok))) {
      return words[i];
    }
  }
  // Any cue token (longest first).
  for (const t of [...cueTokens].sort((a, b) => b.length - a.length)) {
    if (t.length < 4) continue;
    const i = tokens.indexOf(t);
    if (i >= 0) return words[i];
  }
  return undefined;
}

function naturalDuration(a: Action): number {
  switch (a.type) {
    case "text":
      return clamp(a.text.length * 42, 420, 1500);
    case "box":
    case "ellipse":
    case "diamond":
    case "triangle":
      return 750 + (a.text ? clamp(a.text.length * 22, 0, 500) : 0);
    case "line":
    case "arrow": {
      const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      return clamp(len * 1.7, 450, 1100);
    }
    case "curve":
      return 1000;
    case "graph":
      return a.fn ? 1800 : 1100;
    case "highlight":
      return 700;
    case "pointer":
      return 600;
    case "erase":
      return ERASE_MS;
  }
}

function layerOf(a: Action): number {
  switch (a.type) {
    case "highlight":
      return a.style === "marker" ? 0 : 5;
    case "box":
    case "ellipse":
    case "diamond":
    case "triangle":
    case "graph":
      return 1;
    case "line":
    case "arrow":
    case "curve":
      return 2;
    case "text":
      return 3;
    default:
      return 4;
  }
}

export function buildTimeline(script: Script, timings: (SceneTiming | undefined)[]): Timeline {
  const scenes: TimelineScene[] = [];
  const itemsByScene: TimedItem[][] = [];
  let cursor = 0;
  let board = 0;
  /** Items on the current board, by action id (for erase / highlight targets). */
  let visible = new Map<string, TimedItem>();

  script.scenes.forEach((scene, si) => {
    const text = sceneText(scene);
    const timing = timings[si] ?? estimateSceneTiming(text);
    if (scene.clear || si === 0) {
      board = si;
      visible = new Map();
    }

    const start = cursor;
    const words: TimelineWord[] = timing.words.map(([c0, c1, s, e]) => ({
      text: text.slice(c0, c1),
      c0,
      c1,
      start: start + s,
      end: start + e,
    }));
    const lastWordEnd = words.length ? words[words.length - 1].end - start : 0;
    const end = start + Math.max(timing.durationMs, lastWordEnd + 120);

    // Beat boundaries from the words that fall inside each beat's character range.
    const offsets = beatOffsets(scene);
    const beats = scene.beats.map((beat, bi) => {
      const { start: c0, end: c1 } = offsets[bi];
      let w0 = words.findIndex((w) => w.c0 >= c0);
      if (w0 < 0) w0 = words.length;
      let w1 = w0;
      while (w1 < words.length && words[w1].c1 <= c1) w1++;
      let bStart: number;
      let bEnd: number;
      if (w1 > w0) {
        bStart = words[w0].start;
        bEnd = words[w1 - 1].end;
      } else {
        // No word timings: spread beats proportionally over the scene.
        const total = Math.max(1, text.length);
        bStart = start + ((end - start) * c0) / total;
        bEnd = start + ((end - start) * c1) / total;
      }
      return { text: beat.say, start: bStart, end: bEnd, w0, w1 } satisfies TimelineBeat;
    });

    const items: TimedItem[] = [];
    scene.beats.forEach((beat, bi) => {
      const tb = beats[bi];
      const bWords = words.slice(tb.w0, tb.w1);
      const uncued = beat.draw.filter((a) => !(a.cue && findCue(a.cue, bWords)));
      const window = Math.max(300, tb.end - tb.start - 150);
      const slot = Math.max(260, (window / Math.max(1, uncued.length)) * 0.92);
      let uncuedIdx = 0;

      beat.draw.forEach((action) => {
        const cueWord = action.cue ? findCue(action.cue, bWords) : undefined;
        let aStart: number;
        let dur = naturalDuration(action);
        if (cueWord) {
          aStart = Math.max(tb.start, cueWord.start - 80);
        } else {
          aStart = tb.start + 150 + uncuedIdx * slot;
          uncuedIdx++;
          dur = Math.min(dur, Math.max(320, slot * 1.15));
        }

        const key = `${si}:${action.id}`;
        const rect = actionRect(action);
        const item: TimedItem = {
          key,
          scene: si,
          action,
          start: Math.round(aStart),
          dur: Math.round(dur),
          rect,
          layer: layerOf(action),
          seed: hashString(key),
        };

        if (action.type === "highlight") {
          const target = visible.get(action.target);
          if (!target?.rect) return;
          item.targetRect = target.rect;
          item.start = Math.max(item.start, target.start + 120);
        } else if (action.type === "erase") {
          const targets = action.targets.length
            ? action.targets.map((id) => visible.get(id)).filter((t): t is TimedItem => !!t)
            : [...visible.values()];
          for (const t of targets) {
            if (t.action.type === "pointer") continue;
            t.erasedAt = Math.max(item.start, t.start + t.dur);
          }
        } else if (action.type === "pointer" && action.x !== undefined && action.y !== undefined) {
          item.rect = { x0: action.x, y0: action.y, x1: action.x, y1: action.y };
        }

        items.push(item);
        if (action.type !== "erase" && action.type !== "pointer") visible.set(action.id, item);
      });
    });

    items.sort((a, b) => a.start - b.start || a.layer - b.layer);
    itemsByScene.push(items);
    scenes.push({ index: si, title: scene.title, start, end, board, clear: scene.clear || si === 0, text, words, beats });
    cursor = end + SCENE_GAP_MS;
  });

  const duration = (scenes.length ? scenes[scenes.length - 1].end : 0) + TAIL_MS;
  return { duration, scenes, itemsByScene };
}

/** Index of the scene a given time belongs to (the gap after a scene still belongs to it). */
export function sceneIndexAt(tl: Timeline, t: number): number {
  let idx = 0;
  for (let i = 0; i < tl.scenes.length; i++) {
    if (tl.scenes[i].start <= t) idx = i;
    else break;
  }
  return idx;
}

export interface BoardItem {
  item: TimedItem;
  /** 0..1 draw-on progress. */
  progress: number;
  opacity: number;
}

export interface PointerState {
  x: number;
  y: number;
  opacity: number;
}

export interface BoardState {
  scene: number;
  items: BoardItem[];
  pointer: PointerState | null;
}

const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/** The whiteboard at time `t`: a pure function of the timeline, so seeking is exact. */
export function boardAt(tl: Timeline, t: number): BoardState {
  if (tl.scenes.length === 0) return { scene: 0, items: [], pointer: null };
  const s = sceneIndexAt(tl, t);
  const scene = tl.scenes[s];
  const items: BoardItem[] = [];

  for (let si = scene.board; si <= s; si++) {
    for (const item of tl.itemsByScene[si]) {
      if (item.action.type === "pointer" || item.action.type === "erase") continue;
      if (item.start > t) continue;
      const progress = clamp((t - item.start) / item.dur, 0, 1);
      let opacity = 1;
      if (item.erasedAt !== undefined && t >= item.erasedAt) {
        opacity = 1 - (t - item.erasedAt) / ERASE_MS;
        if (opacity <= 0) continue;
      }
      items.push({ item, progress, opacity });
    }
  }

  // The previous board fades out as a new clean page begins.
  if (s > 0 && scene.clear) {
    const dt = t - scene.start;
    if (dt >= 0 && dt < BOARD_FADE_MS) {
      const fade = 1 - dt / BOARD_FADE_MS;
      const prev = tl.scenes[s - 1];
      const leaving: BoardItem[] = [];
      for (let si = prev.board; si <= s - 1; si++) {
        for (const item of tl.itemsByScene[si]) {
          if (item.action.type === "pointer" || item.action.type === "erase") continue;
          if (item.erasedAt !== undefined) continue;
          leaving.push({ item, progress: 1, opacity: fade });
        }
      }
      items.unshift(...leaving);
    }
  }

  items.sort((a, b) => a.item.layer - b.item.layer);

  // Pointer: glide between pointer actions of the current scene.
  let pointer: PointerState | null = null;
  const pointers = tl.itemsByScene[s].filter((i) => i.action.type === "pointer" && i.rect);
  let cur = -1;
  for (let i = 0; i < pointers.length; i++) if (pointers[i].start <= t) cur = i;
  if (cur >= 0) {
    const to = rectCenter(pointers[cur].rect!);
    const from = cur > 0 ? rectCenter(pointers[cur - 1].rect!) : to;
    const k = easeInOut(clamp((t - pointers[cur].start) / pointers[cur].dur, 0, 1));
    pointer = {
      x: from[0] + (to[0] - from[0]) * k,
      y: from[1] + (to[1] - from[1]) * k,
      opacity: clamp((t - pointers[0].start) / 250, 0, 1),
    };
  }

  return { scene: s, items, pointer };
}

export interface SpeechPosition {
  scene: number;
  /** Beat index within the scene, or -1 in silence. */
  beat: number;
  /** Word index within the scene's words, or -1. */
  word: number;
}

/** Which beat/word is being spoken at time `t` (for captions). */
export function speechAt(tl: Timeline, t: number): SpeechPosition {
  const s = sceneIndexAt(tl, t);
  const scene = tl.scenes[s];
  if (!scene || t > scene.end + 80) return { scene: s, beat: -1, word: -1 };
  let word = -1;
  for (let i = 0; i < scene.words.length; i++) if (scene.words[i].start <= t) word = i;
  let beat = -1;
  for (let i = 0; i < scene.beats.length; i++) if (scene.beats[i].start - 120 <= t) beat = i;
  return { scene: s, beat, word };
}
