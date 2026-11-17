import {
  CANVAS,
  CANVAS_MARGIN,
  FONT_SIZE,
  type Action,
  type Align,
  type Point,
  type SizeToken,
} from "./types";

/** Axis-aligned rectangle in canvas units. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const rectW = (r: Rect) => r.x1 - r.x0;
export const rectH = (r: Rect) => r.y1 - r.y0;
export const rectCenter = (r: Rect): Point => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return {
    x0: Math.min(...rects.map((r) => r.x0)),
    y0: Math.min(...rects.map((r) => r.y0)),
    x1: Math.max(...rects.map((r) => r.x1)),
    y1: Math.max(...rects.map((r) => r.y1)),
  };
}

const NARROW = new Set("iljtf.,'!|:;()[]I1 ".split(""));
const WIDE = new Set("mwMW@%&".split(""));

/** Approximate advance width of one character as a fraction of the font size. */
function glyphWidth(ch: string): number {
  if (ch === " ") return 0.3;
  const code = ch.codePointAt(0)!;
  if (code > 0x2000) return 1.05; // emoji, CJK, arrows and other wide symbols
  if (NARROW.has(ch)) return 0.34;
  if (WIDE.has(ch)) return 0.82;
  if (ch >= "A" && ch <= "Z") return 0.62;
  if (ch >= "0" && ch <= "9") return 0.54;
  return 0.5;
}

export const LINE_HEIGHT = 1.22;

export function fontPx(size: SizeToken | number): number {
  return typeof size === "number" ? size : FONT_SIZE[size];
}

/** Estimated rendered size of (possibly multi-line) text. */
export function estimateTextSize(text: string, size: SizeToken | number): { w: number; h: number; lines: number } {
  const px = fontPx(size);
  const lines = text.split("\n");
  let w = 0;
  for (const line of lines) {
    let lw = 0;
    for (const ch of Array.from(line)) lw += glyphWidth(ch) * px;
    w = Math.max(w, lw);
  }
  return { w, h: lines.length * px * LINE_HEIGHT, lines: lines.length };
}

/** Greedy word-wrap so no line is wider than `maxWidth`. */
export function wrapText(text: string, size: SizeToken | number, maxWidth: number): string {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && estimateTextSize(candidate, size).w > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export function textRect(x: number, y: number, text: string, size: SizeToken | number, align: Align): Rect {
  const { w, h } = estimateTextSize(text, size);
  const x0 = align === "left" ? x : align === "right" ? x - w : x - w / 2;
  return { x0, y0: y - h / 2, x1: x0 + w, y1: y + h / 2 };
}

/** Bounding box of an action's own drawing (null for actions without geometry). */
export function actionRect(a: Action): Rect | null {
  switch (a.type) {
    case "text":
      return textRect(a.x, a.y, a.text, a.size, a.align);
    case "box":
    case "ellipse":
    case "diamond":
    case "triangle":
    case "graph":
      return { x0: a.x - a.w / 2, y0: a.y - a.h / 2, x1: a.x + a.w / 2, y1: a.y + a.h / 2 };
    case "line":
    case "arrow":
      return {
        x0: Math.min(a.x1, a.x2),
        y0: Math.min(a.y1, a.y2),
        x1: Math.max(a.x1, a.x2),
        y1: Math.max(a.y1, a.y2),
      };
    case "curve": {
      if (a.points.length === 0) return null;
      const xs = a.points.map((p) => p[0]);
      const ys = a.points.map((p) => p[1]);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
    default:
      return null;
  }
}

/**
 * Where the laser pointer rests when it "points at" an element: just off its lower-right edge, so
 * the dot never covers the text it is pointing at.
 */
export function pointerAnchor(a: Action, r: Rect): Point {
  const [cx, cy] = rectCenter(r);
  if (a.type === "ellipse") {
    // 45 degrees down-right on the ellipse outline
    return [cx + (rectW(r) / 2) * 0.72 + 6, cy + (rectH(r) / 2) * 0.72 + 6];
  }
  if (a.type === "text") return [r.x1 + 12, r.y1 + 4];
  if (a.type === "arrow" || a.type === "line" || a.type === "curve") return [cx + 14, cy + 14];
  return [r.x1 - 6, r.y1 - 4];
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Shift a rect (and report the shift) so it sits inside the canvas margins. */
export function shiftIntoCanvas(r: Rect): { dx: number; dy: number } {
  const m = CANVAS_MARGIN;
  let dx = 0;
  let dy = 0;
  if (rectW(r) > CANVAS.width - 2 * m) dx = m - r.x0 + (CANVAS.width - 2 * m - rectW(r)) / 2;
  else if (r.x0 < m) dx = m - r.x0;
  else if (r.x1 > CANVAS.width - m) dx = CANVAS.width - m - r.x1;
  if (rectH(r) > CANVAS.height - 2 * m) dy = m - r.y0 + (CANVAS.height - 2 * m - rectH(r)) / 2;
  else if (r.y0 < m) dy = m - r.y0;
  else if (r.y1 > CANVAS.height - m) dy = CANVAS.height - m - r.y1;
  return { dx, dy };
}

/** Point where the ray from the center of `r` toward `toward` leaves `r`, pushed out by `gap`. */
export function edgePoint(r: Rect, toward: Point, gap = 10): Point {
  const [cx, cy] = rectCenter(r);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = rectW(r) / 2 + gap;
  const hh = rectH(r) / 2 + gap;
  const scale = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * scale, cy + dy * scale];
}

/** Deterministic 32-bit hash used to seed hand-drawn jitter so shapes never "wobble" between renders. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647 || 1;
}
