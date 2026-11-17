import rough from "roughjs";
import { samplePlot, compileExpression } from "@/lib/lesson/expr";
import { LINE_HEIGHT, fontPx, rectCenter, rectH, rectW, type Rect } from "@/lib/lesson/geometry";
import type { TimedItem } from "@/lib/lesson/timeline";
import type { Action, GraphAction, LineAction, Point } from "@/lib/lesson/types";
import { INK, SOFT } from "./palette";

/**
 * Turns a timed whiteboard action into "pieces": hand-drawn strokes, fills, text and dots, each
 * with a progress window [from, to] inside the action's 0..1 draw-on progress. The React layer
 * just renders pieces; seeking works because a piece's look depends only on progress.
 */

export type Piece =
  | { t: "stroke"; d: string; color: string; width: number; from: number; to: number; dashed?: boolean }
  | { t: "fill"; d: string; color: string; opacity: number; from: number; to: number }
  | {
      t: "text";
      lines: string[];
      x: number;
      y: number;
      px: number;
      anchor: "start" | "middle" | "end";
      color: string;
      weight: number;
      from: number;
      to: number;
      clip: Rect | null;
      pop?: boolean;
      halo?: boolean;
    }
  | { t: "dot"; cx: number; cy: number; r: number; color: string; from: number; to: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; rx: number; color: string; opacity: number; from: number; to: number; multiply?: boolean };

const gen = rough.generator();

interface RoughOpts {
  seed: number;
  stroke: string;
  width: number;
  roughness?: number;
  fill?: string;
}

function roughPieces(drawable: ReturnType<typeof gen.line>, from: number, to: number, fillFrom = 0.35): Piece[] {
  const out: Piece[] = [];
  for (const p of gen.toPaths(drawable)) {
    if (p.stroke === "none" && p.fill) {
      out.push({ t: "fill", d: p.d, color: p.fill, opacity: 1, from: fillFrom, to: Math.min(1, fillFrom + 0.4) });
    } else {
      out.push({ t: "stroke", d: p.d, color: p.stroke, width: p.strokeWidth, from, to });
    }
  }
  return out;
}

const baseOpts = (o: RoughOpts) => ({
  seed: o.seed,
  stroke: o.stroke,
  strokeWidth: o.width,
  roughness: o.roughness ?? 1.15,
  bowing: 1.1,
  fill: o.fill,
  fillStyle: "solid" as const,
});

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;

function textPiece(
  text: string,
  x: number,
  y: number,
  px: number,
  anchor: "start" | "middle" | "end",
  color: string,
  weight: number,
  from: number,
  to: number,
  clip: Rect | null,
  extra: Partial<Extract<Piece, { t: "text" }>> = {},
): Piece {
  return {
    t: "text",
    lines: text.split("\n"),
    x,
    y,
    px,
    anchor,
    color,
    weight,
    from,
    to,
    clip,
    pop: EMOJI_ONLY.test(text) || undefined,
    ...extra,
  };
}

function arrowHead(tip: Point, from: Point, len = 30, spread = 0.46): Point[] {
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  return [
    [tip[0] - len * Math.cos(ang - spread), tip[1] - len * Math.sin(ang - spread)],
    tip,
    [tip[0] - len * Math.cos(ang + spread), tip[1] - len * Math.sin(ang + spread)],
  ];
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

const fmt = (v: number) => String(Number(v.toFixed(6)));

function linePieces(a: LineAction, seed: number): Piece[] {
  const color = INK[a.color];
  const p1: Point = [a.x1, a.y1];
  const p2: Point = [a.x2, a.y2];
  const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
  const nx = -(p2[1] - p1[1]) / len;
  const ny = (p2[0] - p1[0]) / len;
  const mid: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const opts = baseOpts({ seed, stroke: color, width: 3.6, roughness: 0.9 });
  const pieces: Piece[] = [];

  let startDir: Point = p2; // point the start head looks away from
  let endDir: Point = p1; // point the end head looks away from
  let labelAt: Point = mid;
  let d: string;
  if (Math.abs(a.bend) > 0.02) {
    const ctrl: Point = [mid[0] + nx * a.bend * len * 0.4, mid[1] + ny * a.bend * len * 0.4];
    d = `M ${p1[0]} ${p1[1]} Q ${ctrl[0]} ${ctrl[1]} ${p2[0]} ${p2[1]}`;
    startDir = ctrl;
    endDir = ctrl;
    labelAt = [0.25 * p1[0] + 0.5 * ctrl[0] + 0.25 * p2[0], 0.25 * p1[1] + 0.5 * ctrl[1] + 0.25 * p2[1]];
    const drawable = gen.path(d, opts);
    pieces.push(...roughPieces(drawable, 0, 0.85).filter((p) => p.t === "stroke"));
  } else {
    pieces.push(...roughPieces(gen.line(p1[0], p1[1], p2[0], p2[1], opts), 0, 0.85));
  }
  if (a.dashed) {
    for (const p of pieces) if (p.t === "stroke") p.dashed = true;
  }
  if (a.head === "end" || a.head === "both") {
    const head = gen.linearPath(arrowHead(p2, endDir), { ...opts, roughness: 0.6 });
    pieces.push(...roughPieces(head, 0.8, 1));
  }
  if (a.head === "both") {
    const head = gen.linearPath(arrowHead(p1, startDir), { ...opts, roughness: 0.6 });
    pieces.push(...roughPieces(head, 0.8, 1));
  }
  if (a.text) {
    const px = fontPx(a.size);
    const off = 0.9 * px + 6;
    // Keep labels above horizontal-ish lines and beside vertical ones.
    const sign = ny <= 0 ? 1 : -1;
    pieces.push(
      textPiece(a.text, labelAt[0] + nx * off * sign, labelAt[1] + ny * off * sign, px, "middle", INK.ink, 400, 0.55, 1, null, { halo: true }),
    );
  }
  return pieces;
}

function graphPieces(a: GraphAction, seed: number): Piece[] {
  const color = INK[a.color];
  const x0 = a.x - a.w / 2;
  const y0 = a.y - a.h / 2;
  const X = (dx: number) => x0 + ((dx - a.xmin) / (a.xmax - a.xmin)) * a.w;
  const Y = (dy: number) => y0 + a.h - ((dy - a.ymin) / (a.ymax - a.ymin)) * a.h;
  const axisY = Y(a.ymin <= 0 && a.ymax >= 0 ? 0 : a.ymin);
  const axisX = X(a.xmin <= 0 && a.xmax >= 0 ? 0 : a.xmin);
  const axisOpts = baseOpts({ seed, stroke: INK.ink, width: 3, roughness: 0.7 });
  const pieces: Piece[] = [];

  // Axes with arrow heads.
  pieces.push(...roughPieces(gen.line(x0, axisY, x0 + a.w, axisY, axisOpts), 0, 0.22));
  pieces.push(...roughPieces(gen.line(axisX, y0 + a.h, axisX, y0, axisOpts), 0, 0.22));
  pieces.push(...roughPieces(gen.linearPath(arrowHead([x0 + a.w + 6, axisY], [x0 + a.w - 14, axisY], 20), axisOpts), 0.18, 0.28));
  pieces.push(...roughPieces(gen.linearPath(arrowHead([axisX, y0 - 6], [axisX, y0 + 14], 20), axisOpts), 0.18, 0.28));

  // Ticks and numbers.
  const stepX = niceStep(a.xmax - a.xmin, Math.min(9, Math.max(3, a.w / 110)));
  const stepY = niceStep(a.ymax - a.ymin, Math.min(8, Math.max(3, a.h / 90)));
  let tickPath = "";
  const tickFrom = 0.2;
  for (let v = Math.ceil(a.xmin / stepX) * stepX; v <= a.xmax + 1e-9; v += stepX) {
    if (Math.abs(v) < stepX / 1e3) continue;
    const px = X(v);
    tickPath += `M ${px} ${axisY - 7} L ${px} ${axisY + 7} `;
    pieces.push(textPiece(fmt(v), px, axisY + 30, 24, "middle", INK.gray, 400, tickFrom, 0.4, null));
  }
  for (let v = Math.ceil(a.ymin / stepY) * stepY; v <= a.ymax + 1e-9; v += stepY) {
    if (Math.abs(v) < stepY / 1e3) continue;
    const py = Y(v);
    tickPath += `M ${axisX - 7} ${py} L ${axisX + 7} ${py} `;
    pieces.push(textPiece(fmt(v), axisX - 14, py, 24, "end", INK.gray, 400, tickFrom, 0.4, null));
  }
  if (tickPath) pieces.push({ t: "stroke", d: tickPath, color: INK.ink, width: 2.5, from: tickFrom, to: 0.4 });

  if (a.xLabel) pieces.push(textPiece(a.xLabel, x0 + a.w - 4, axisY - 26, 28, "end", INK.ink, 400, 0.3, 0.5, null));
  if (a.yLabel) pieces.push(textPiece(a.yLabel, axisX + 16, y0 - 2, 28, "start", INK.ink, 400, 0.3, 0.5, null));

  // The function.
  const fn = a.fn ? compileExpression(a.fn) : null;
  if (fn) {
    for (const seg of samplePlot(fn, a.xmin, a.xmax, a.ymin, a.ymax)) {
      const pts = seg.map(([dx, dy]) => [X(dx), Y(dy)] as const);
      const d = pts.map(([px, py], i) => `${i ? "L" : "M"} ${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
      pieces.push({ t: "stroke", d, color, width: 5.5, from: 0.3, to: 0.9 });
    }
  }

  // Marked points.
  a.points.forEach(([dx, dy], i) => {
    const px = X(dx);
    const py = Y(dy);
    pieces.push({ t: "dot", cx: px, cy: py, r: 10, color: INK.red, from: 0.88, to: 1 });
    const label = a.labels[i];
    if (label) pieces.push(textPiece(label, px + 18, py - 22, 30, "start", INK.ink, 700, 0.9, 1, null, { halo: true }));
  });
  return pieces;
}

function build(action: Action, item: TimedItem): Piece[] {
  const seed = item.seed;
  switch (action.type) {
    case "text": {
      const px = fontPx(action.size);
      const lines = action.text.split("\n");
      const lineH = px * LINE_HEIGHT;
      const anchor = action.align === "left" ? "start" : action.align === "right" ? "end" : "middle";
      const clip = item.rect ? { ...item.rect, x0: item.rect.x0 - 6, x1: item.rect.x1 + 14 } : null;
      const bold = action.size === "lg" || action.size === "xl";
      return [
        textPiece(
          action.text,
          action.x,
          action.y - ((lines.length - 1) * lineH) / 2,
          px,
          anchor,
          INK[action.color],
          bold ? 700 : 400,
          0,
          1,
          clip,
        ),
      ];
    }

    case "box":
    case "ellipse":
    case "diamond":
    case "triangle": {
      const { x, y, w, h } = action;
      const opts = baseOpts({
        seed,
        stroke: INK[action.color],
        width: 3.6,
        fill: action.fill ? SOFT[action.fill] : undefined,
      });
      let drawable: ReturnType<typeof gen.line>;
      if (action.type === "box") drawable = gen.rectangle(x - w / 2, y - h / 2, w, h, opts);
      else if (action.type === "ellipse") drawable = gen.ellipse(x, y, w, h, opts);
      else if (action.type === "diamond") {
        drawable = gen.polygon([[x, y - h / 2], [x + w / 2, y], [x, y + h / 2], [x - w / 2, y]], opts);
      } else {
        drawable = gen.polygon([[x, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]], opts);
      }
      const pieces = roughPieces(drawable, 0, action.text ? 0.72 : 1);
      if (action.text) {
        const px = fontPx(action.size);
        const lines = action.text.split("\n");
        const lineH = px * LINE_HEIGHT;
        const cy = y + (action.type === "triangle" ? h * 0.14 : 0);
        pieces.push(
          textPiece(action.text, x, cy - ((lines.length - 1) * lineH) / 2, px, "middle", INK.ink, 700, 0.5, 1, null),
        );
      }
      return pieces;
    }

    case "line":
    case "arrow":
      return linePieces(action, seed);

    case "curve": {
      const opts = baseOpts({ seed, stroke: INK[action.color], width: 3.8, roughness: 0.8 });
      const pieces = roughPieces(gen.curve(action.points, opts), 0, action.arrow ? 0.85 : 1);
      if (action.dashed) for (const p of pieces) if (p.t === "stroke") p.dashed = true;
      const n = action.points.length;
      if (action.arrow && n >= 2) {
        const tip = action.points[n - 1];
        const prev = action.points[Math.max(0, n - 3)];
        pieces.push(...roughPieces(gen.linearPath(arrowHead(tip, prev), { ...opts, roughness: 0.6 }), 0.8, 1));
      }
      if (action.text) {
        const mid = action.points[Math.floor(n / 2)];
        pieces.push(textPiece(action.text, mid[0], mid[1] - 34, fontPx(action.size), "middle", INK.ink, 400, 0.6, 1, null, { halo: true }));
      }
      return pieces;
    }

    case "graph":
      return graphPieces(action, seed);

    case "highlight": {
      const r = item.targetRect;
      if (!r) return [];
      const [cx, cy] = rectCenter(r);
      const color = INK[action.color];
      if (action.style === "marker") {
        return [
          {
            t: "rect",
            x: r.x0 - 10,
            y: r.y0 + rectH(r) * 0.18,
            w: rectW(r) + 20,
            h: rectH(r) * 0.72,
            rx: 8,
            color: action.color === "yellow" ? "#ffe45c" : color,
            opacity: 0.5,
            from: 0,
            to: 1,
            multiply: true,
          },
        ];
      }
      if (action.style === "underline") {
        const y = r.y1 + 8;
        const opts = baseOpts({ seed, stroke: color, width: 5.5, roughness: 1.3 });
        return roughPieces(
          gen.curve(
            [
              [r.x0 - 6, y],
              [cx, y + 7],
              [r.x1 + 6, y - 2],
            ],
            opts,
          ),
          0,
          1,
        );
      }
      const opts = baseOpts({ seed, stroke: color, width: 5, roughness: action.style === "circle" ? 1.7 : 1.2 });
      if (action.style === "box") {
        return roughPieces(gen.rectangle(r.x0 - 16, r.y0 - 12, rectW(r) + 32, rectH(r) + 24, opts), 0, 1);
      }
      return roughPieces(gen.ellipse(cx, cy, rectW(r) * 1.22 + 56, rectH(r) * 1.3 + 42, opts), 0, 1);
    }

    default:
      return [];
  }
}

const cache = new WeakMap<TimedItem, Piece[]>();

/** Pieces for an item (memoized per timeline item, so rough.js runs once per element). */
export function piecesFor(item: TimedItem): Piece[] {
  let pieces = cache.get(item);
  if (!pieces) {
    pieces = build(item.action, item);
    cache.set(item, pieces);
  }
  return pieces;
}

/** Smooth freehand points into a path (quadratic midpoints). */
export function strokePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]} l 0.1 0.1`;
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i][0] + points[i + 1][0]) / 2;
    const my = (points[i][1] + points[i + 1][1]) / 2;
    d += ` Q ${points[i][0].toFixed(1)} ${points[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
}
