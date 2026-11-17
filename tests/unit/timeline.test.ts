import { describe, expect, it } from "vitest";
import { estimateSceneTiming } from "@/lib/lesson/estimate";
import {
  BOARD_FADE_MS,
  SCENE_GAP_MS,
  boardAt,
  buildTimeline,
  sceneIndexAt,
  speechAt,
} from "@/lib/lesson/timeline";
import { sceneText, type Action, type SceneTiming, type Script } from "@/lib/lesson/types";

const text = (id: string, t: string, extra: Partial<Action> = {}): Action =>
  ({ type: "text", id, text: t, x: 640, y: 200, size: "md", color: "ink", align: "center", ...extra }) as Action;
const box = (id: string, x: number, extra: Partial<Action> = {}): Action =>
  ({ type: "box", id, x, y: 400, w: 200, h: 100, color: "ink", size: "sm", ...extra }) as Action;

// "Plants need sunlight. They also drink water."
//  words: Plants need sunlight. | They also drink water.
const T0: SceneTiming = {
  durationMs: 3000,
  words: [
    [0, 6, 100, 400],
    [7, 11, 450, 700],
    [12, 21, 750, 1300],
    [22, 26, 1500, 1700],
    [27, 31, 1750, 1950],
    [32, 37, 2000, 2300],
    [38, 44, 2350, 2800],
  ],
};

function script(): Script {
  return {
    title: "T",
    summary: "",
    suggestions: [],
    scenes: [
      {
        title: "Plants",
        clear: true,
        beats: [
          {
            say: "Plants need sunlight.",
            draw: [text("title", "Plants", { y: 100 }), box("sun", 300, { cue: "sunlight" })],
          },
          { say: "They also drink water.", draw: [box("water", 900), { type: "pointer", id: "p", target: "water", x: 900, y: 400 } as Action] },
        ],
      },
      {
        title: "Next",
        clear: true,
        beats: [{ say: "A fresh board.", draw: [box("n1", 400)] }],
      },
      {
        title: "More",
        clear: false,
        beats: [
          { say: "Same board.", draw: [box("n2", 800), { type: "erase", id: "er", targets: ["n1"] } as Action] },
        ],
      },
    ],
  };
}

const timings = (): SceneTiming[] => [T0, estimateSceneTiming("A fresh board."), estimateSceneTiming("Same board.")];

describe("buildTimeline", () => {
  const sc = script();
  expect(sceneText(sc.scenes[0])).toBe("Plants need sunlight. They also drink water.");
  const tl = buildTimeline(sc, timings());

  it("lays scenes out one after another with a gap", () => {
    expect(tl.scenes[0].start).toBe(0);
    expect(tl.scenes[0].end).toBe(3000);
    expect(tl.scenes[1].start).toBe(3000 + SCENE_GAP_MS);
    expect(tl.scenes[2].start).toBe(tl.scenes[1].end + SCENE_GAP_MS);
    expect(tl.duration).toBeGreaterThan(tl.scenes[2].end);
  });

  it("derives beat boundaries from word timings", () => {
    const [b0, b1] = tl.scenes[0].beats;
    expect(b0.start).toBe(100);
    expect(b0.end).toBe(1300);
    expect(b1.start).toBe(1500);
    expect(b1.end).toBe(2800);
  });

  it("starts cued actions when the cue word is spoken", () => {
    const sun = tl.itemsByScene[0].find((i) => i.action.id === "sun")!;
    expect(sun.start).toBe(750 - 80);
  });

  it("spreads uncued actions across the beat, never before it starts", () => {
    const title = tl.itemsByScene[0].find((i) => i.action.id === "title")!;
    expect(title.start).toBeGreaterThanOrEqual(100);
    expect(title.start).toBeLessThan(700);
    const water = tl.itemsByScene[0].find((i) => i.action.id === "water")!;
    expect(water.start).toBeGreaterThanOrEqual(1500);
  });

  it("falls back to uncued timing when a cue phrase is not in the beat", () => {
    const s = script();
    s.scenes[0].beats[0].draw[1] = box("sun", 300, { cue: "volcano" });
    const t2 = buildTimeline(s, timings());
    const sun = t2.itemsByScene[0].find((i) => i.action.id === "sun")!;
    expect(sun.start).toBeGreaterThanOrEqual(100);
    expect(sun.start).toBeLessThan(1300);
  });

  it("matches cues by stem", () => {
    const s = script();
    s.scenes[0].beats[0].draw[1] = box("sun", 300, { cue: "sunlig" });
    const t2 = buildTimeline(s, timings());
    expect(t2.itemsByScene[0].find((i) => i.action.id === "sun")!.start).toBe(670);
  });

  it("works when no word timings exist (spreads beats proportionally)", () => {
    const t2 = buildTimeline(script(), [{ durationMs: 4000, words: [] }, undefined, undefined]);
    const [b0, b1] = t2.scenes[0].beats;
    expect(b0.start).toBeLessThan(b1.start);
    expect(b1.end).toBeLessThanOrEqual(4000 + 1);
  });
});

describe("boardAt", () => {
  const tl = buildTimeline(script(), timings());

  it("shows nothing before the first drawing starts", () => {
    expect(boardAt(tl, 0).items).toHaveLength(0);
  });

  it("animates progress from 0 to 1 and is deterministic", () => {
    const sun = tl.itemsByScene[0].find((i) => i.action.id === "sun")!;
    const mid = boardAt(tl, sun.start + sun.dur / 2).items.find((i) => i.item.action.id === "sun")!;
    expect(mid.progress).toBeCloseTo(0.5, 1);
    const done = boardAt(tl, sun.start + sun.dur + 10).items.find((i) => i.item.action.id === "sun")!;
    expect(done.progress).toBe(1);
    expect(boardAt(tl, 2000)).toEqual(boardAt(tl, 2000)); // pure function of t
  });

  it("seeking backwards removes elements that have not been drawn yet", () => {
    const late = boardAt(tl, 2900).items.map((i) => i.item.action.id);
    expect(late).toContain("water");
    const early = boardAt(tl, 1000).items.map((i) => i.item.action.id);
    expect(early).not.toContain("water");
  });

  it("starts a clean board on a clearing scene and fades the old one briefly", () => {
    const s1 = tl.scenes[1].start;
    const at = boardAt(tl, s1 + 50);
    const ids = at.items.map((i) => i.item.key);
    expect(ids.some((k) => k.startsWith("0:"))).toBe(true); // leaving items
    const leaving = at.items.find((i) => i.item.key.startsWith("0:"))!;
    expect(leaving.opacity).toBeLessThan(1);
    expect(leaving.opacity).toBeGreaterThan(0);
    const after = boardAt(tl, s1 + BOARD_FADE_MS + 50);
    expect(after.items.every((i) => i.item.key.startsWith("1:"))).toBe(true);
  });

  it("keeps the previous drawing when a scene does not clear, and erases on request", () => {
    const s2 = tl.scenes[2];
    const erase = tl.itemsByScene[2].find((i) => i.action.type === "erase")!;
    const n1 = tl.itemsByScene[1].find((i) => i.action.id === "n1")!;
    expect(n1.erasedAt).toBeDefined();
    const before = boardAt(tl, s2.start + 5).items.map((i) => i.item.action.id);
    expect(before).toContain("n1");
    const mid = boardAt(tl, n1.erasedAt! + 200).items.find((i) => i.item.action.id === "n1")!;
    expect(mid.opacity).toBeLessThan(1);
    const gone = boardAt(tl, n1.erasedAt! + 600).items.map((i) => i.item.action.id);
    expect(gone).not.toContain("n1");
    expect(erase.start).toBeGreaterThanOrEqual(s2.start);
  });

  it("moves the pointer to its target", () => {
    const p = tl.itemsByScene[0].find((i) => i.action.type === "pointer")!;
    expect(boardAt(tl, p.start - 100).pointer).toBeNull();
    const end = boardAt(tl, p.start + p.dur + 50).pointer!;
    expect(end.x).toBeCloseTo(900);
    expect(end.y).toBeCloseTo(400);
    expect(end.opacity).toBe(1);
  });
});

describe("position helpers", () => {
  const tl = buildTimeline(script(), timings());

  it("sceneIndexAt keeps the gap with the previous scene", () => {
    expect(sceneIndexAt(tl, -50)).toBe(0);
    expect(sceneIndexAt(tl, 3100)).toBe(0); // in the gap
    expect(sceneIndexAt(tl, tl.scenes[1].start)).toBe(1);
    expect(sceneIndexAt(tl, tl.duration)).toBe(2);
  });

  it("speechAt reports the spoken beat and word", () => {
    expect(speechAt(tl, 800)).toEqual({ scene: 0, beat: 0, word: 2 });
    expect(speechAt(tl, 2000)).toMatchObject({ scene: 0, beat: 1, word: 5 });
    expect(speechAt(tl, 3200).beat).toBe(-1); // silence in the gap
  });
});

describe("estimateSceneTiming", () => {
  const sentence = "The quick brown fox jumps over the lazy dog, then it runs away. ";
  it("is monotonic, covers every word and runs near 150 wpm", () => {
    const t = sentence.repeat(25).trim(); // 13 words x 25 = 325 words
    const timing = estimateSceneTiming(t);
    expect(timing.words).toHaveLength(325);
    for (let i = 1; i < timing.words.length; i++) {
      expect(timing.words[i][2]).toBeGreaterThanOrEqual(timing.words[i - 1][3]);
    }
    const wpm = 325 / (timing.durationMs / 60000);
    expect(wpm).toBeGreaterThan(120);
    expect(wpm).toBeLessThan(180);
  });
  it("scales with playback speed", () => {
    const slow = estimateSceneTiming(sentence);
    const fast = estimateSceneTiming(sentence, 2);
    expect(fast.durationMs).toBeLessThan(slow.durationMs * 0.6);
  });
});
