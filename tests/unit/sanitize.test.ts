import { describe, expect, it } from "vitest";
import { actionRect } from "@/lib/lesson/geometry";
import { ScriptError, checkLessonQuality, cleanNarration, sanitizeScript } from "@/lib/lesson/sanitize";
import { CANVAS, CANVAS_MARGIN, type Action, type ShapeAction } from "@/lib/lesson/types";

const scene = (beats: unknown[], extra: Record<string, unknown> = {}) => ({ title: "S", beats, ...extra });
const lesson = (scenes: unknown[]) => ({ title: "T", summary: "sum", scenes, suggestions: ["a?", "b?", "c?", "d?"] });
const lessonMode = { mode: "lesson" } as const;

function firstScene(draw: unknown[]) {
  const { script, warnings } = sanitizeScript(
    lesson([scene([{ say: "Hello there", draw }]), scene([{ say: "Second", draw: [] }])]),
    lessonMode,
  );
  return { actions: script.scenes[0].beats[0].draw, script, warnings };
}

describe("sanitizeScript", () => {
  it("keeps valid actions and clamps coordinates into the canvas margins", () => {
    const { actions } = firstScene([
      { type: "text", text: "Far away", x: 5000, y: -300, size: "lg" },
      { type: "box", x: -100, y: 9000, w: 200, h: 100 },
    ]);
    expect(actions).toHaveLength(2);
    for (const a of actions) {
      const r = actionRect(a)!;
      expect(r.x0).toBeGreaterThanOrEqual(CANVAS_MARGIN - 0.001);
      expect(r.y0).toBeGreaterThanOrEqual(CANVAS_MARGIN - 0.001);
      expect(r.x1).toBeLessThanOrEqual(CANVAS.width - CANVAS_MARGIN + 0.001);
      expect(r.y1).toBeLessThanOrEqual(CANVAS.height - CANVAS_MARGIN + 0.001);
    }
  });

  it("drops unknown action types and actions missing required fields, with warnings", () => {
    const { actions, warnings } = firstScene([
      { type: "banana", x: 1, y: 1 },
      { type: "text", x: 10, y: 10 }, // no text
      { type: "box", w: 100, h: 100 }, // no position
      { type: "text", text: "ok", x: 400, y: 400 },
    ]);
    expect(actions).toHaveLength(1);
    expect(warnings.length).toBe(3);
  });

  it("replaces unknown colours/sizes with defaults and de-duplicates ids", () => {
    const { actions } = firstScene([
      { type: "text", id: "a", text: "one", x: 300, y: 300, color: "chartreuse", size: "huge" },
      { type: "text", id: "a", text: "two", x: 300, y: 400 },
    ]);
    expect(actions[0]).toMatchObject({ color: "ink", size: "md" });
    expect(new Set(actions.map((a) => a.id)).size).toBe(2);
  });

  it("wraps very long text and grows shapes to fit their labels", () => {
    const long = "word ".repeat(30).trim();
    const { actions } = firstScene([
      { type: "text", text: long, x: 640, y: 200, size: "md" },
      { type: "box", id: "b", x: 640, y: 500, w: 100, h: 50, text: "A fairly long label for a tiny box", size: "md" },
    ]);
    expect((actions[0] as { text: string }).text).toContain("\n");
    const box = actions[1] as ShapeAction;
    expect(box.w).toBeGreaterThan(100);
    expect(box.h).toBeGreaterThan(50);
    expect(box.text).toBeTruthy();
  });

  describe("shapes that grow into their neighbours", () => {
    const solid = (a: Action) => actionRect(a)!;
    const touching = (a: Action, b: Action) => {
      const p = solid(a);
      const q = solid(b);
      return Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 0 && Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) > 0;
    };

    it("pushes a shape clear when growing to fit its label created the overlap", () => {
      // Spaced for their requested sizes (they just touch), but the labels make both grow.
      const { actions } = firstScene([
        { type: "ellipse", id: "e", x: 340, y: 350, w: 200, h: 120, text: "Virus\nParticle", size: "md" },
        { type: "diamond", id: "d", x: 540, y: 350, w: 200, h: 130, text: "Antigen\nKey", size: "md" },
      ]);
      const [e, d] = actions;
      expect((e as ShapeAction).w).toBeGreaterThan(200); // sanity: growth is what causes the clash
      expect((d as ShapeAction).w).toBeGreaterThan(200);
      expect(touching(e, d)).toBe(false);
      expect((d as ShapeAction).y).toBe(350); // moved along the axis of least overlap only
    });

    it("keeps connectors glued to the shape's final position", () => {
      const { actions } = firstScene([
        { type: "ellipse", id: "e", x: 340, y: 350, w: 200, h: 120, text: "Virus\nParticle", size: "md" },
        { type: "diamond", id: "d", x: 540, y: 350, w: 200, h: 130, text: "Antigen\nKey", size: "md" },
        { type: "arrow", id: "a", from: "e", to: "d" },
      ]);
      const arrow = actions[2] as { x1: number; x2: number };
      expect(arrow.x1).toBeCloseTo(solid(actions[0]).x1 + 10, 3);
      expect(arrow.x2).toBeCloseTo(solid(actions[1]).x0 - 10, 3);
      expect(arrow.x2).toBeGreaterThan(arrow.x1); // the arrow still points from the first shape to the second
    });

    it("leaves deliberate overlaps alone (Venn diagrams)", () => {
      // The model asked for overlapping circles; their long labels make both grow even more.
      const { actions } = firstScene([
        { type: "ellipse", id: "a", x: 500, y: 400, w: 200, h: 160, text: "Cats and kittens everywhere", size: "md" },
        { type: "ellipse", id: "b", x: 620, y: 400, w: 200, h: 160, text: "Dogs and puppies everywhere", size: "md" },
      ]);
      expect((actions[0] as ShapeAction).w).toBeGreaterThan(200); // the growth path really ran
      expect((actions[0] as ShapeAction).x).toBe(500);
      expect((actions[1] as ShapeAction).x).toBe(620);
    });

    it("leaves a shape drawn inside a bigger one alone", () => {
      const { actions } = firstScene([
        { type: "box", id: "cell", x: 640, y: 400, w: 600, h: 400 },
        { type: "ellipse", id: "nucleus", x: 640, y: 400, w: 120, h: 80, text: "Nucleus of the cell", size: "sm" },
      ]);
      expect((actions[1] as ShapeAction).w).toBeGreaterThan(120); // the growth path really ran
      expect((actions[1] as ShapeAction).x).toBe(640);
      expect((actions[1] as ShapeAction).y).toBe(400);
    });

    it("does not move shapes that were already well spaced", () => {
      const { actions } = firstScene([
        { type: "box", id: "a", x: 240, y: 400, w: 260, h: 130, text: "Sun", size: "md" },
        { type: "box", id: "b", x: 640, y: 400, w: 260, h: 130, text: "Plant", size: "md" },
        { type: "box", id: "c", x: 1040, y: 400, w: 260, h: 130, text: "Sugar", size: "md" },
      ]);
      expect(actions.map((a) => (a as ShapeAction).x)).toEqual([240, 640, 1040]);
    });

    it("still keeps every shape inside the canvas after nudging", () => {
      const { actions } = firstScene([
        { type: "ellipse", id: "e", x: 960, y: 350, w: 200, h: 120, text: "Virus\nParticle", size: "md" },
        { type: "diamond", id: "d", x: 1160, y: 350, w: 200, h: 130, text: "Antigen\nKey", size: "md" },
      ]);
      for (const a of actions) {
        const r = solid(a);
        expect(r.x0).toBeGreaterThanOrEqual(CANVAS_MARGIN - 0.001);
        expect(r.x1).toBeLessThanOrEqual(CANVAS.width - CANVAS_MARGIN + 0.001);
      }
    });
  });

  it("glues arrows to the shapes they reference", () => {
    const { actions } = firstScene([
      { type: "box", id: "a", x: 300, y: 400, w: 200, h: 100 },
      { type: "box", id: "b", x: 900, y: 400, w: 200, h: 100 },
      { type: "arrow", from: "a", to: "b" },
    ]);
    const arrow = actions[2];
    if (arrow.type !== "arrow") throw new Error("expected arrow");
    // starts just right of box a (x = 300 + 100 + gap) and ends just left of box b
    expect(arrow.x1).toBeGreaterThan(400);
    expect(arrow.x1).toBeLessThan(430);
    expect(arrow.x2).toBeLessThan(800);
    expect(arrow.x2).toBeGreaterThan(770);
    expect(arrow.y1).toBeCloseTo(400);
    expect(arrow.from).toBe("a");
  });

  it("drops arrows without usable endpoints and highlights with unknown targets", () => {
    const { actions } = firstScene([
      { type: "arrow", from: "ghost", to: "phantom" },
      { type: "highlight", target: "ghost" },
      { type: "text", id: "t", text: "hi", x: 400, y: 300 },
      { type: "highlight", target: "t", style: "underline" },
    ]);
    expect(actions.map((a) => a.type)).toEqual(["text", "highlight"]);
  });

  it("folds a silent beat's drawing into the next spoken beat", () => {
    const { script } = sanitizeScript(
      lesson([
        scene([
          { say: "", draw: [{ type: "text", text: "early", x: 300, y: 300 }] },
          { say: "Now we talk", draw: [] },
        ]),
        scene([{ say: "Another", draw: [] }]),
      ]),
      lessonMode,
    );
    expect(script.scenes[0].beats).toHaveLength(1);
    expect(script.scenes[0].beats[0].draw).toHaveLength(1);
  });

  it("only allows references to elements on the current board", () => {
    const { script } = sanitizeScript(
      lesson([
        scene([{ say: "One", draw: [{ type: "box", id: "x", x: 300, y: 300 }] }]),
        scene([{ say: "Two", draw: [{ type: "highlight", target: "x" }] }]), // new clear board: x is gone
        scene([{ say: "Three", draw: [{ type: "box", id: "y", x: 300, y: 300 }] }]),
        scene(
          [{ say: "Four", draw: [{ type: "highlight", target: "y" }] }],
          { clear: false }, // keeps scene 3's board: y is still there
        ),
      ]),
      lessonMode,
    );
    expect(script.scenes[1].beats[0].draw).toHaveLength(0);
    expect(script.scenes[3].beats[0].draw).toHaveLength(1);
    expect(script.scenes[3].clear).toBe(false);
  });

  it("validates graph functions and keeps axes when the function is invalid", () => {
    const { actions, warnings } = firstScene([
      { type: "graph", x: 640, y: 400, fn: "x^2", xmin: -3, xmax: 3, ymin: 0, ymax: 9 },
      { type: "graph", x: 640, y: 400, fn: "evil(x)", xmin: 5, xmax: 1 },
    ]);
    expect(actions).toHaveLength(2);
    expect((actions[0] as { fn?: string }).fn).toBe("x^2");
    const second = actions[1] as { fn?: string; xmin: number; xmax: number };
    expect(second.fn).toBeUndefined();
    expect(second.xmin).toBeLessThan(second.xmax);
    expect(warnings.some((w) => w.includes("not understood"))).toBe(true);
  });

  it("accepts flat, nested and object point lists for curves", () => {
    const { actions } = firstScene([
      { type: "curve", points: [100, 100, 300, 200, 500, 100] },
      { type: "curve", points: [[100, 100], [300, 200]] },
      { type: "curve", points: [{ x: 100, y: 100 }, { x: 200, y: 300 }] },
      { type: "curve", points: [100, 100] }, // only one point: dropped
    ]);
    expect(actions).toHaveLength(3);
  });

  it("enforces lesson/answer scene counts", () => {
    expect(() => sanitizeScript(lesson([scene([{ say: "Only one", draw: [] }])]), lessonMode)).toThrow(ScriptError);
    expect(() => sanitizeScript("nope", lessonMode)).toThrow(ScriptError);
    const empty = sanitizeScript({ title: "A", summary: "s", scenes: [] }, { mode: "answer" });
    expect(empty.script.scenes).toHaveLength(0);
    const many = sanitizeScript(
      { title: "A", scenes: [1, 2, 3].map((i) => scene([{ say: `S${i}`, draw: [] }])) },
      { mode: "answer" },
    );
    expect(many.script.scenes).toHaveLength(2);
  });

  it("caps suggestions at three", () => {
    const { script } = firstScene([]);
    expect(script.suggestions).toHaveLength(3);
  });
});

describe("cleanNarration", () => {
  it("removes markdown, emoji and stage directions and ends with punctuation", () => {
    expect(cleanNarration("Plants **love** sunlight 🌞 [draws a sun]")).toBe("Plants love sunlight.");
    expect(cleanNarration("  Already fine!  ")).toBe("Already fine!");
    expect(cleanNarration("# Title")).toBe("Title.");
    expect(cleanNarration(42)).toBe("");
  });
});

describe("checkLessonQuality", () => {
  const mkAction = (i: number): Action => ({ type: "text", id: `t${i}`, text: "x", x: 100, y: 100, size: "md", color: "ink", align: "center" });
  const scriptOf = (scenes: number, wordsPerScene: number) => ({
    title: "T",
    summary: "",
    suggestions: [],
    scenes: Array.from({ length: scenes }, (_, i) => ({
      title: `S${i}`,
      clear: true,
      beats: [{ say: Array(wordsPerScene).fill("word").join(" ") + ".", draw: [mkAction(1), mkAction(2)] }],
    })),
  });

  it("accepts a ~300 word, 6 scene lesson", () => {
    expect(checkLessonQuality(scriptOf(6, 55)).problems).toEqual([]);
  });
  it("flags too long, too short and too few scenes", () => {
    expect(checkLessonQuality(scriptOf(6, 90)).problems.join()).toContain("words");
    expect(checkLessonQuality(scriptOf(6, 20)).problems.join()).toContain("words");
    expect(checkLessonQuality(scriptOf(2, 140)).problems.join()).toContain("scenes");
  });
});

describe("pointer placement", () => {
  it("rests beside the target instead of covering its centre", () => {
    const { actions } = firstScene([
      { type: "text", id: "t", text: "Thrust", x: 700, y: 400, size: "lg" },
      { type: "pointer", target: "t" },
      { type: "ellipse", id: "e", x: 300, y: 400, w: 300, h: 200 },
      { type: "pointer", target: "e" },
    ]);
    const [text, p1, ellipse, p2] = actions;
    const tr = actionRect(text)!;
    if (p1.type !== "pointer" || p2.type !== "pointer") throw new Error("expected pointers");
    expect(p1.x!).toBeGreaterThan(tr.x1); // just right of the word
    const er = actionRect(ellipse)!;
    expect(p2.x!).toBeGreaterThan(300); // lower-right of the ellipse centre
    expect(p2.y!).toBeGreaterThan(400);
    expect(p2.x!).toBeLessThan(er.x1 + 10);
  });
});
