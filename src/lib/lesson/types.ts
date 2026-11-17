/**
 * Shared lesson model.
 *
 * A lesson is a `Script`: an ordered list of scenes. Each scene is one whiteboard page made of
 * "beats". A beat is a sentence of narration (`say`) plus the whiteboard actions (`draw`) that
 * should appear while it is being spoken. Actions may carry a `cue` (a short phrase from `say`)
 * so they start exactly when that word is spoken.
 *
 * All coordinates live on a fixed virtual canvas (CANVAS) and the renderer scales it to fit.
 */

export const CANVAS = { width: 1280, height: 800 } as const;
/** Elements are kept at least this far from the canvas edge. */
export const CANVAS_MARGIN = 28;

export const COLOR_TOKENS = [
  "ink",
  "blue",
  "red",
  "green",
  "orange",
  "purple",
  "teal",
  "pink",
  "gray",
  "yellow",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const SIZE_TOKENS = ["sm", "md", "lg", "xl"] as const;
export type SizeToken = (typeof SIZE_TOKENS)[number];
/** Font size in canvas units for each size token. */
export const FONT_SIZE: Record<SizeToken, number> = { sm: 34, md: 42, lg: 56, xl: 80 };

export const ACTION_TYPES = [
  "text",
  "box",
  "ellipse",
  "diamond",
  "triangle",
  "line",
  "arrow",
  "curve",
  "graph",
  "highlight",
  "pointer",
  "erase",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const HIGHLIGHT_STYLES = ["circle", "underline", "box", "marker"] as const;
export type HighlightStyle = (typeof HIGHLIGHT_STYLES)[number];

export type Align = "left" | "center" | "right";
export type Point = [number, number];

interface BaseAction {
  /** Unique within the scene; other actions reference it (arrows, highlights, pointer, erase). */
  id: string;
  /** Short phrase from the beat's narration; the action starts when it is spoken. */
  cue?: string;
}

export interface TextAction extends BaseAction {
  type: "text";
  text: string;
  /** Anchor: horizontal position per `align`; y is the vertical middle of the text. */
  x: number;
  y: number;
  size: SizeToken;
  color: ColorToken;
  align: Align;
}

export interface ShapeAction extends BaseAction {
  type: "box" | "ellipse" | "diamond" | "triangle";
  /** Center of the shape. */
  x: number;
  y: number;
  w: number;
  h: number;
  color: ColorToken;
  /** Optional pastel fill. */
  fill?: ColorToken;
  /** Optional label drawn inside the shape. */
  text?: string;
  size: SizeToken;
}

export interface LineAction extends BaseAction {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Optionally glue the ends to other elements (by id); overrides x1,y1 / x2,y2. */
  from?: string;
  to?: string;
  /** -1..1: curvature (0 = straight). */
  bend: number;
  color: ColorToken;
  dashed: boolean;
  head: "end" | "both" | "none";
  /** Optional label near the middle of the line. */
  text?: string;
  size: SizeToken;
}

export interface CurveAction extends BaseAction {
  type: "curve";
  points: Point[];
  color: ColorToken;
  dashed: boolean;
  arrow: boolean;
  text?: string;
  size: SizeToken;
}

export interface GraphAction extends BaseAction {
  type: "graph";
  /** Center and size of the plot area. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Expression in x, e.g. "x^2 - 2*x + 1" or "sin(x)". Omit to draw axes only. */
  fn?: string;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  color: ColorToken;
  xLabel?: string;
  yLabel?: string;
  /** Marked points in DATA coordinates: [x1,y1,x2,y2,...] with optional labels. */
  points: Point[];
  labels: string[];
}

export interface HighlightAction extends BaseAction {
  type: "highlight";
  target: string;
  style: HighlightStyle;
  color: ColorToken;
}

export interface PointerAction extends BaseAction {
  type: "pointer";
  target?: string;
  x?: number;
  y?: number;
}

export interface EraseAction extends BaseAction {
  type: "erase";
  /** Element ids to erase; empty means everything on the board. */
  targets: string[];
}

export type Action =
  | TextAction
  | ShapeAction
  | LineAction
  | CurveAction
  | GraphAction
  | HighlightAction
  | PointerAction
  | EraseAction;

export interface Beat {
  /** One or two sentences of narration. */
  say: string;
  draw: Action[];
}

export interface Scene {
  title: string;
  /** Start from a clean board (default). When false the previous scene's drawing stays. */
  clear: boolean;
  beats: Beat[];
}

export interface Script {
  title: string;
  summary: string;
  scenes: Scene[];
  /** Suggested follow-up questions. */
  suggestions: string[];
}

/** [startChar, endChar, startMs, endMs] of a spoken word; chars index into `sceneText(scene)`. */
export type WordTiming = [number, number, number, number];

export interface SceneTiming {
  durationMs: number;
  words: WordTiming[];
}

/** Narration of a scene as one string - exactly what is sent to text-to-speech. */
export function sceneText(scene: Scene): string {
  return scene.beats
    .map((b) => b.say.trim())
    .filter(Boolean)
    .join(" ");
}

/** Character offset of each beat inside `sceneText(scene)`. */
export function beatOffsets(scene: Scene): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let pos = 0;
  for (const beat of scene.beats) {
    const text = beat.say.trim();
    if (!text) {
      out.push({ start: pos, end: pos });
      continue;
    }
    out.push({ start: pos, end: pos + text.length });
    pos += text.length + 1; // joining space
  }
  return out;
}

export function scriptWordCount(script: Script): number {
  return script.scenes.reduce((n, s) => n + sceneText(s).split(/\s+/).filter(Boolean).length, 0);
}
