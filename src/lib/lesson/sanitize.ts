import { compileExpression } from "./expr";
import {
  actionRect,
  clamp,
  edgePoint,
  estimateTextSize,
  overlapDepth,
  pointerAnchor,
  rectCenter,
  shiftIntoCanvas,
  textRect,
  wrapText,
  type Rect,
} from "./geometry";
import {
  CANVAS,
  CANVAS_MARGIN,
  COLOR_TOKENS,
  HIGHLIGHT_STYLES,
  SIZE_TOKENS,
  scriptWordCount,
  type Action,
  type Beat,
  type ColorToken,
  type GraphAction,
  type HighlightStyle,
  type Point,
  type Scene,
  type Script,
  type ShapeAction,
  type SizeToken,
} from "./types";

/**
 * The model returns loosely-typed JSON. This module converts it into a strictly valid `Script`:
 * unknown fields are dropped, numbers are clamped into the canvas, labels are wrapped and shapes
 * grown to fit them, connectors are glued to the shapes they reference, and anything unusable is
 * discarded (with a warning) rather than failing the whole lesson.
 */

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

export interface SanitizeOptions {
  /** "lesson": 3+ scenes required. "answer": 0-2 short scenes allowed. */
  mode: "lesson" | "answer";
}

export interface SanitizeResult {
  script: Script;
  warnings: string[];
}

const MAX_SCENES = 8;
const MAX_BEATS = 10;
const MAX_ACTIONS_PER_SCENE = 22;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function multilineStr(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v
    .split(/\r?\n|\\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function pickColor(v: unknown, fallback: ColorToken): ColorToken {
  return typeof v === "string" && (COLOR_TOKENS as readonly string[]).includes(v) ? (v as ColorToken) : fallback;
}

function pickSize(v: unknown, fallback: SizeToken): SizeToken {
  return typeof v === "string" && (SIZE_TOKENS as readonly string[]).includes(v) ? (v as SizeToken) : fallback;
}

/** Accepts [x1,y1,x2,y2,...], [[x,y],...] or [{x,y},...]. */
function toPoints(v: unknown, max: number): Point[] {
  if (!Array.isArray(v)) return [];
  const out: Point[] = [];
  if (v.every((n) => typeof n === "number" || typeof n === "string")) {
    for (let i = 0; i + 1 < v.length; i += 2) {
      const x = num(v[i]);
      const y = num(v[i + 1]);
      if (x !== undefined && y !== undefined) out.push([x, y]);
    }
  } else {
    for (const p of v) {
      if (Array.isArray(p)) {
        const x = num(p[0]);
        const y = num(p[1]);
        if (x !== undefined && y !== undefined) out.push([x, y]);
      } else if (isObj(p)) {
        const x = num(p.x);
        const y = num(p.y);
        if (x !== undefined && y !== undefined) out.push([x, y]);
      }
    }
  }
  return out.slice(0, max);
}

/** Strip anything that text-to-speech reads badly (markdown, emoji, stage directions). */
export function cleanNarration(v: unknown): string {
  if (typeof v !== "string") return "";
  let s = v
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/\[[^\]]*\]|\([^)]*(draws?|writes?|points?)[^)]*\)/gi, "") // "[draws a sun]"
    .replace(/[*_`#>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s && !/[.!?…:;]$/.test(s)) s += ".";
  return s;
}

interface Ctx {
  /** Elements the current board can reference, keyed by id. */
  known: Map<string, Action>;
  warnings: string[];
  scene: number;
}

function rectOfKnown(ctx: Ctx, id: unknown): Rect | null {
  if (typeof id !== "string") return null;
  const a = ctx.known.get(id);
  return a ? actionRect(a) : null;
}

function uniqueId(ctx: Ctx, wanted: unknown, counter: { n: number }): string {
  let id = typeof wanted === "string" ? wanted.trim().replace(/[^\w-]/g, "_").slice(0, 40) : "";
  if (!id) id = `e${++counter.n}`;
  while (ctx.known.has(id)) id = `${id.replace(/_\d+$/, "")}_${++counter.n}`;
  return id;
}

function growForLabel(
  type: "box" | "ellipse" | "diamond" | "triangle",
  w: number,
  h: number,
  label: string,
  size: SizeToken,
): { w: number; h: number; text: string; size: SizeToken } {
  // The usable text area of non-rectangular shapes is smaller than their bounding box.
  const inset = { box: [1, 1], ellipse: [1.38, 1.38], diamond: [1.9, 1.9], triangle: [1.7, 1.9] }[type];
  let s = size;
  let text = label;
  for (;;) {
    const innerW = Math.max(120, w / inset[0] - 36);
    text = wrapText(label, s, innerW);
    const need = estimateTextSize(text, s);
    const needW = (need.w + 36) * inset[0];
    const needH = (need.h + 24) * inset[1];
    if ((needW <= w * 1.35 && needH <= h * 1.5) || s === "sm") {
      return { w: clamp(Math.max(w, needW), 90, 760), h: clamp(Math.max(h, needH), 70, 520), text, size: s };
    }
    s = SIZE_TOKENS[Math.max(0, SIZE_TOKENS.indexOf(s) - 1)];
  }
}

/** Space kept between a nudged shape and the neighbour it was pushed away from. */
const NUDGE_GAP = 28;
/** A requested overlap deeper than this on both axes is treated as deliberate (Venn diagram, nesting). */
const DELIBERATE_OVERLAP = 8;

/** Closed shapes and graphs: the elements that must not collide with each other. */
type Solid = ShapeAction | GraphAction;
/** The rect each shape had before growing to fit its label (shapes without growth are not listed). */
const requestedRects = new WeakMap<Action, Rect>();
const isSolid = (a: Action): a is Solid =>
  a.type === "box" || a.type === "ellipse" || a.type === "diamond" || a.type === "triangle" || a.type === "graph";

/**
 * Growing a shape to fit its label can run it into a neighbour that the model spaced for the
 * shape's requested size. Push the grown shape clear, but only for overlaps that the growth
 * introduced: overlaps that were already there in the requested layout are intentional and stay.
 * Nothing references a shape before it is registered, so moving it here is safe for connectors.
 */
function nudgeClearOfNeighbours(action: Solid, requested: Rect, known: Map<string, Action>) {
  for (let pass = 0; pass < 4; pass++) {
    const mine = actionRect(action)!;
    let moved = false;
    for (const other of known.values()) {
      if (!isSolid(other)) continue;
      const theirs = actionRect(other)!;
      const now = overlapDepth(mine, theirs);
      if (now.x <= 0 || now.y <= 0) continue;
      const was = overlapDepth(requested, requestedRects.get(other) ?? theirs);
      if (was.x > DELIBERATE_OVERLAP && was.y > DELIBERATE_OVERLAP) continue;

      const [mx, my] = rectCenter(mine);
      const [tx, ty] = rectCenter(theirs);
      if (now.x <= now.y) action.x += (mx >= tx ? 1 : -1) * (now.x + NUDGE_GAP);
      else action.y += (my >= ty ? 1 : -1) * (now.y + NUDGE_GAP);
      const { dx, dy } = shiftIntoCanvas(actionRect(action)!);
      action.x += dx;
      action.y += dy;
      moved = true;
      break; // geometry changed: re-check against every neighbour
    }
    if (!moved) return;
  }
}

function sanitizeAction(raw: unknown, ctx: Ctx, counter: { n: number }): Action | null {
  if (!isObj(raw) || typeof raw.type !== "string") return null;
  const type = raw.type;
  const cue = str(raw.cue, 60) || undefined;
  const warn = (msg: string) => ctx.warnings.push(`scene ${ctx.scene + 1}: ${type} dropped (${msg})`);

  switch (type) {
    case "text": {
      let text = multilineStr(raw.text, 140);
      const x = num(raw.x);
      const y = num(raw.y);
      if (!text || x === undefined || y === undefined) return warn("missing text/x/y"), null;
      const size = pickSize(raw.size, "md");
      const align = raw.align === "left" || raw.align === "right" ? raw.align : "center";
      text = wrapText(text, size, 920);
      const action: Action = {
        type: "text",
        id: uniqueId(ctx, raw.id, counter),
        cue,
        text,
        x,
        y,
        size,
        color: pickColor(raw.color, "ink"),
        align,
      };
      const { dx, dy } = shiftIntoCanvas(textRect(x, y, text, size, align));
      action.x += dx;
      action.y += dy;
      return action;
    }

    case "box":
    case "ellipse":
    case "diamond":
    case "triangle": {
      const x = num(raw.x);
      const y = num(raw.y);
      if (x === undefined || y === undefined) return warn("missing x/y"), null;
      const defaults = { box: [260, 120], ellipse: [250, 150], diamond: [260, 170], triangle: [230, 190] }[type];
      let w = clamp(num(raw.w) ?? defaults[0], 60, 900);
      let h = clamp(num(raw.h) ?? defaults[1], 50, 600);
      const requested: Rect = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
      const label = multilineStr(raw.text, 90);
      let size = pickSize(raw.size, "sm");
      let text: string | undefined;
      if (label) {
        const grown = growForLabel(type, w, h, label, size);
        w = grown.w;
        h = grown.h;
        text = grown.text;
        size = grown.size;
      }
      const action: Action = {
        type,
        id: uniqueId(ctx, raw.id, counter),
        cue,
        x,
        y,
        w,
        h,
        color: pickColor(raw.color, "ink"),
        fill: raw.fill ? pickColor(raw.fill, "yellow") : undefined,
        text,
        size,
      };
      const { dx, dy } = shiftIntoCanvas(actionRect(action)!);
      action.x += dx;
      action.y += dy;
      if (w !== requested.x1 - requested.x0 || h !== requested.y1 - requested.y0) {
        nudgeClearOfNeighbours(action as ShapeAction, requested, ctx.known);
        requestedRects.set(action, requested); // so later neighbours can tell deliberate overlaps from growth
      }
      return action;
    }

    case "line":
    case "arrow": {
      const fromRect = rectOfKnown(ctx, raw.from);
      const toRect = rectOfKnown(ctx, raw.to);
      let x1 = num(raw.x1);
      let y1 = num(raw.y1);
      let x2 = num(raw.x2);
      let y2 = num(raw.y2);
      if (fromRect && toRect) {
        [x1, y1] = edgePoint(fromRect, rectCenter(toRect));
        [x2, y2] = edgePoint(toRect, rectCenter(fromRect));
      } else if (fromRect && x2 !== undefined && y2 !== undefined) {
        [x1, y1] = edgePoint(fromRect, [x2, y2]);
      } else if (toRect && x1 !== undefined && y1 !== undefined) {
        [x2, y2] = edgePoint(toRect, [x1, y1]);
      }
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
        return warn("missing endpoints"), null;
      }
      const lo = CANVAS_MARGIN;
      const label = multilineStr(raw.text, 50);
      return {
        type,
        id: uniqueId(ctx, raw.id, counter),
        cue,
        x1: clamp(x1, lo, CANVAS.width - lo),
        y1: clamp(y1, lo, CANVAS.height - lo),
        x2: clamp(x2, lo, CANVAS.width - lo),
        y2: clamp(y2, lo, CANVAS.height - lo),
        from: typeof raw.from === "string" && fromRect ? raw.from : undefined,
        to: typeof raw.to === "string" && toRect ? raw.to : undefined,
        bend: clamp(num(raw.bend) ?? 0, -1, 1),
        color: pickColor(raw.color, "ink"),
        dashed: raw.dashed === true,
        head: raw.head === "both" || raw.head === "none" || raw.head === "end" ? raw.head : type === "arrow" ? "end" : "none",
        text: label || undefined,
        size: pickSize(raw.size, "sm"),
      };
    }

    case "curve": {
      const points = toPoints(raw.points, 60).map(
        ([px, py]): Point => [clamp(px, CANVAS_MARGIN, CANVAS.width - CANVAS_MARGIN), clamp(py, CANVAS_MARGIN, CANVAS.height - CANVAS_MARGIN)],
      );
      if (points.length < 2) return warn("needs 2+ points"), null;
      return {
        type: "curve",
        id: uniqueId(ctx, raw.id, counter),
        cue,
        points,
        color: pickColor(raw.color, "ink"),
        dashed: raw.dashed === true,
        arrow: raw.head === "end" || raw.arrow === true,
        text: multilineStr(raw.text, 50) || undefined,
        size: pickSize(raw.size, "sm"),
      };
    }

    case "graph": {
      const x = num(raw.x);
      const y = num(raw.y);
      if (x === undefined || y === undefined) return warn("missing x/y"), null;
      let xmin = num(raw.xmin) ?? -5;
      let xmax = num(raw.xmax) ?? 5;
      let ymin = num(raw.ymin) ?? -5;
      let ymax = num(raw.ymax) ?? 5;
      if (xmin >= xmax) [xmin, xmax] = [-5, 5];
      if (ymin >= ymax) [ymin, ymax] = [-5, 5];
      let fn = str(raw.fn, 120) || undefined;
      if (fn && !compileExpression(fn)) {
        ctx.warnings.push(`scene ${ctx.scene + 1}: graph function "${fn}" not understood; axes only`);
        fn = undefined;
      }
      const dataPoints = toPoints(raw.points, 8);
      const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 8).map((l) => str(l, 24)) : [];
      const action: GraphAction = {
        type: "graph",
        id: uniqueId(ctx, raw.id, counter),
        cue,
        x,
        y,
        w: clamp(num(raw.w) ?? 640, 240, 1100),
        h: clamp(num(raw.h) ?? 440, 180, 700),
        fn,
        xmin,
        xmax,
        ymin,
        ymax,
        color: pickColor(raw.color, "blue"),
        xLabel: str(raw.xLabel, 24) || undefined,
        yLabel: str(raw.yLabel, 24) || undefined,
        points: dataPoints,
        labels,
      };
      const { dx, dy } = shiftIntoCanvas(actionRect(action)!);
      action.x += dx;
      action.y += dy;
      return action;
    }

    case "highlight": {
      const target = typeof raw.target === "string" ? raw.target : "";
      if (!rectOfKnown(ctx, target)) return warn(`unknown target "${target}"`), null;
      const style: HighlightStyle = (HIGHLIGHT_STYLES as readonly string[]).includes(String(raw.style))
        ? (raw.style as HighlightStyle)
        : "circle";
      return {
        type: "highlight",
        id: uniqueId(ctx, raw.id, counter),
        cue,
        target,
        style,
        color: pickColor(raw.color, style === "marker" ? "yellow" : "red"),
      };
    }

    case "pointer": {
      const target = typeof raw.target === "string" ? raw.target : undefined;
      const r = rectOfKnown(ctx, target);
      let x = num(raw.x);
      let y = num(raw.y);
      if (r && target) [x, y] = pointerAnchor(ctx.known.get(target)!, r);
      if (x === undefined || y === undefined) return warn("no target"), null;
      return {
        type: "pointer",
        id: uniqueId(ctx, raw.id, counter),
        cue,
        target: r ? target : undefined,
        x: clamp(x, 0, CANVAS.width),
        y: clamp(y, 0, CANVAS.height),
      };
    }

    case "erase": {
      const wanted = Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === "string") : [];
      const targets = wanted.filter((t) => ctx.known.has(t));
      if (wanted.length > 0 && targets.length === 0) return warn("no known targets"), null;
      return { type: "erase", id: uniqueId(ctx, raw.id, counter), cue, targets };
    }

    default:
      return warn("unknown type"), null;
  }
}

function sanitizeScene(raw: unknown, index: number, known: Map<string, Action>, warnings: string[]): Scene | null {
  if (!isObj(raw)) return null;
  const clear = index === 0 ? true : raw.clear !== false;
  if (clear) known.clear();
  const ctx: Ctx = { known, warnings, scene: index };
  const counter = { n: 0 };
  let actionCount = 0;

  const beats: Beat[] = [];
  let carry: Action[] = [];
  const rawBeats = Array.isArray(raw.beats) ? raw.beats.slice(0, MAX_BEATS) : [];
  for (const rb of rawBeats) {
    if (!isObj(rb)) continue;
    const say = cleanNarration(rb.say);
    const draw: Action[] = [...carry];
    carry = [];
    for (const ra of Array.isArray(rb.draw) ? rb.draw : []) {
      if (actionCount >= MAX_ACTIONS_PER_SCENE) {
        warnings.push(`scene ${index + 1}: extra actions dropped (limit ${MAX_ACTIONS_PER_SCENE})`);
        break;
      }
      const a = sanitizeAction(ra, ctx, counter);
      if (!a) continue;
      known.set(a.id, a);
      draw.push(a);
      actionCount++;
    }
    if (!say) {
      carry = draw; // silent beat: fold its drawing into the next spoken beat
      continue;
    }
    // A cue must be a phrase that really appears in this beat; otherwise it is ignored later.
    beats.push({ say, draw });
  }
  if (carry.length && beats.length) beats[beats.length - 1].draw.push(...carry);
  if (beats.length === 0) return null;

  return {
    title: str(raw.title, 48) || `Part ${index + 1}`,
    clear,
    beats,
  };
}

export function sanitizeScript(input: unknown, opts: SanitizeOptions): SanitizeResult {
  if (!isObj(input)) throw new ScriptError("Model output was not a JSON object");
  const warnings: string[] = [];

  const rawScenes = Array.isArray(input.scenes) ? input.scenes.slice(0, MAX_SCENES) : [];
  const known = new Map<string, Action>();
  const scenes: Scene[] = [];
  for (const rs of rawScenes) {
    const scene = sanitizeScene(rs, scenes.length, known, warnings);
    if (scene) scenes.push(scene);
  }

  if (opts.mode === "lesson" && scenes.length < 2) {
    throw new ScriptError(`Lesson needs at least 2 scenes with narration (got ${scenes.length})`);
  }
  if (opts.mode === "answer" && scenes.length > 2) scenes.length = 2;

  const suggestions = (Array.isArray(input.suggestions) ? input.suggestions : [])
    .map((s) => str(s, 100))
    .filter(Boolean)
    .slice(0, 3);

  const title = str(input.title, 90) || scenes[0]?.title || "Lesson";
  const summary = str(input.summary, 320);
  return { script: { title, summary, scenes, suggestions }, warnings };
}

export interface QualityReport {
  words: number;
  problems: string[];
}

/** Checks the script is a sensible ~2 minute lesson. Problems are fed back to the model on retry. */
export function checkLessonQuality(script: Script): QualityReport {
  const words = scriptWordCount(script);
  const problems: string[] = [];
  if (script.scenes.length < 4) problems.push(`only ${script.scenes.length} scenes; use 5 or 6`);
  if (words < 200) problems.push(`narration is only ${words} words; it must be 330-420 words (about 2 minutes)`);
  if (words > 520) problems.push(`narration is ${words} words; it must be 330-420 words (about 2 minutes)`);
  script.scenes.forEach((s, i) => {
    const visible = s.beats.flatMap((b) => b.draw).filter((a) => !["pointer", "erase", "highlight"].includes(a.type));
    if (visible.length < 2) problems.push(`scene ${i + 1} ("${s.title}") draws almost nothing; add diagrams or labels`);
  });
  return { words, problems };
}
