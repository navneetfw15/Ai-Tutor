"use client";

import {
  Eraser,
  Hand,
  Maximize2,
  Minimize2,
  Minus,
  PenLine,
  Plus,
  Scan,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CANVAS, type Point } from "@/lib/lesson/types";
import type { BoardState } from "@/lib/lesson/timeline";
import { strokePath } from "@/lib/whiteboard/draw";
import { BOARD_BG, INK } from "@/lib/whiteboard/palette";
import { cn } from "@/lib/utils";
import { BoardItem } from "./BoardItem";

export type Tool = "pan" | "pen" | "eraser";

export interface UserStroke {
  id: string;
  color: string;
  width: number;
  points: Point[];
}

const PEN_COLORS = [INK.ink, INK.blue, INK.red, INK.green] as const;
const MAX_ZOOM = 4;

interface View {
  k: number;
  x: number;
  y: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function constrain(v: View): View {
  const k = clamp(v.k, 1, MAX_ZOOM);
  return {
    k,
    x: clamp(v.x, 0, CANVAS.width - CANVAS.width / k),
    y: clamp(v.y, 0, CANVAS.height - CANVAS.height / k),
  };
}

interface Props {
  board: BoardState | null;
  strokes: UserStroke[];
  onStrokesChange: (next: UserStroke[]) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Changing this resets zoom (e.g. a different lesson). */
  resetKey: string;
}

export function Whiteboard({ board, strokes, onStrokesChange, isFullscreen, onToggleFullscreen, resetKey }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("pan");
  const [penColor, setPenColor] = useState<string>(INK.ink);
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [draft, setDraft] = useState<Point[] | null>(null);

  // Event handlers read the latest values through refs that are synced after each render.
  const viewRef = useRef(view);
  const strokesRef = useRef(strokes);
  useEffect(() => {
    viewRef.current = view;
    strokesRef.current = strokes;
  });

  // Pointer bookkeeping for pan / pinch / draw.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "none" | "pan" | "pinch" | "draw" | "erase"; dist?: number; mid?: Point }>({ kind: "none" });
  const draftRef = useRef<Point[] | null>(null);

  // Reset zoom when a different lesson/answer is shown ("adjust state while rendering" pattern).
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setView({ k: 1, x: 0, y: 0 });
  }

  const toBoard = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return [0, 0];
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return [p.x, p.y];
  }, []);

  const zoomAt = useCallback((p: Point, nextK: number) => {
    const v = viewRef.current;
    const k = clamp(nextK, 1, MAX_ZOOM);
    setView(constrain({ k, x: p[0] - (p[0] - v.x) * (v.k / k), y: p[1] - (p[1] - v.y) * (v.k / k) }));
  }, []);

  const zoomCenter = useCallback(
    (factor: number) => {
      const v = viewRef.current;
      zoomAt([v.x + CANVAS.width / v.k / 2, v.y + CANVAS.height / v.k / 2], v.k * factor);
    },
    [zoomAt],
  );

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms; plain wheel keeps scrolling the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(toBoard(e.clientX, e.clientY), viewRef.current.k * Math.exp(-e.deltaY * 0.0025));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toBoard, zoomAt]);

  const eraseAt = useCallback(
    (p: Point) => {
      const radius = 34 / viewRef.current.k;
      const next = strokesRef.current.filter((s) => !s.points.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < radius));
      if (next.length !== strokesRef.current.length) onStrokesChange(next);
    },
    [onStrokesChange],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      // Second finger: abandon any stroke and start a pinch.
      draftRef.current = null;
      setDraft(null);
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: toBoard((a.x + b.x) / 2, (a.y + b.y) / 2) };
      return;
    }
    const p = toBoard(e.clientX, e.clientY);
    if (tool === "pen") {
      gesture.current = { kind: "draw" };
      draftRef.current = [p];
      setDraft([p]);
    } else if (tool === "eraser") {
      gesture.current = { kind: "erase" };
      eraseAt(p);
    } else {
      gesture.current = { kind: "pan" };
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();

    if (g.kind === "pinch" && pointers.current.size >= 2 && ctm) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const v = viewRef.current;
      const k = clamp(v.k * (dist / (g.dist || dist)), 1, MAX_ZOOM);
      // The board point that was under the fingers when the pinch began must stay under the
      // fingers' midpoint, which gives pinch-zoom and two-finger pan in one gesture.
      const midNow = toBoard((a.x + b.x) / 2, (a.y + b.y) / 2);
      const anchor = g.mid ?? midNow;
      const fx = (midNow[0] - v.x) / (CANVAS.width / v.k); // midpoint's fraction across the viewport
      const fy = (midNow[1] - v.y) / (CANVAS.height / v.k);
      setView(constrain({ k, x: anchor[0] - fx * (CANVAS.width / k), y: anchor[1] - fy * (CANVAS.height / k) }));
      gesture.current = { kind: "pinch", dist, mid: anchor };
      return;
    }
    if (g.kind === "draw" && draftRef.current) {
      const p = toBoard(e.clientX, e.clientY);
      const last = draftRef.current[draftRef.current.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 2.5 / viewRef.current.k) {
        draftRef.current = [...draftRef.current, p];
        setDraft(draftRef.current);
      }
    } else if (g.kind === "erase") {
      eraseAt(toBoard(e.clientX, e.clientY));
    } else if (g.kind === "pan" && ctm && viewRef.current.k > 1) {
      const v = viewRef.current;
      setView(constrain({ ...v, x: v.x - (e.clientX - prev.x) / ctm.a, y: v.y - (e.clientY - prev.y) / ctm.d }));
    }
  };

  const endPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (gesture.current.kind === "draw" && draftRef.current && pointers.current.size === 0) {
      const points = draftRef.current;
      onStrokesChange([
        ...strokesRef.current,
        { id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, color: penColor, width: 5 / Math.sqrt(viewRef.current.k), points },
      ]);
    }
    if (pointers.current.size === 0) {
      gesture.current = { kind: "none" };
      draftRef.current = null;
      setDraft(null);
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: tool === "pan" ? "pan" : "none" };
    }
  };

  const vb = `${view.x} ${view.y} ${CANVAS.width / view.k} ${CANVAS.height / view.k}`;
  const cursor = tool === "pen" ? "crosshair" : tool === "eraser" ? "cell" : view.k > 1 ? "grab" : "default";
  const draftD = useMemo(() => (draft ? strokePath(draft) : ""), [draft]);

  return (
    <div className="board-frame relative h-full w-full overflow-hidden rounded-[inherit]" data-testid="whiteboard">
      <svg
        ref={svgRef}
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        className="block h-full w-full touch-none select-none"
        style={{ cursor }}
        role="img"
        aria-label="Interactive whiteboard"
        data-testid="board-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={() => setView({ k: 1, x: 0, y: 0 })}
      >
        <defs>
          <pattern id="wb-dots" width="32" height="32" patternUnits="userSpaceOnUse">
            <circle cx="16" cy="16" r="1.5" fill="#e7e0cc" />
          </pattern>
        </defs>
        <rect width={CANVAS.width} height={CANVAS.height} fill={BOARD_BG} />
        <rect width={CANVAS.width} height={CANVAS.height} fill="url(#wb-dots)" />

        <g data-testid="board-items">
          {board?.items.map(({ item, progress, opacity }) => (
            <BoardItem key={item.key} item={item} progress={progress} opacity={opacity} />
          ))}
        </g>

        {/* The learner's own notes */}
        <g fill="none" strokeLinecap="round" strokeLinejoin="round" data-testid="user-strokes">
          {strokes.map((s) => (
            <path key={s.id} d={strokePath(s.points)} stroke={s.color} strokeWidth={s.width} />
          ))}
          {draft && <path d={draftD} stroke={penColor} strokeWidth={5 / Math.sqrt(view.k)} />}
        </g>

        {board?.pointer && (
          <g transform={`translate(${board.pointer.x} ${board.pointer.y})`} opacity={board.pointer.opacity} pointerEvents="none">
            <circle r={26} fill="#ef4444" opacity={0.22} className="pointer-pulse" />
            <circle r={11} fill="#ef4444" stroke="#fff" strokeWidth={3.5} />
          </g>
        )}
      </svg>

      {/* Toolbar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-2 p-1.5 sm:p-3">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-black/10 bg-white/90 p-1 shadow-sm backdrop-blur">
          <ToolButton label="Move and zoom" active={tool === "pan"} onClick={() => setTool("pan")}>
            <Hand className="size-4" />
          </ToolButton>
          <ToolButton label="Pen: write your own notes" active={tool === "pen"} onClick={() => setTool("pen")}>
            <PenLine className="size-4" />
          </ToolButton>
          <ToolButton label="Eraser for your notes" active={tool === "eraser"} onClick={() => setTool("eraser")}>
            <Eraser className="size-4" />
          </ToolButton>
          {tool === "pen" && (
            <div className="ml-1 flex items-center gap-1 border-l border-black/10 pl-2" role="group" aria-label="Pen colour">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Pen colour ${c}`}
                  aria-pressed={penColor === c}
                  onClick={() => setPenColor(c)}
                  className={cn(
                    "size-5 rounded-full border-2 transition-transform",
                    penColor === c ? "scale-110 border-black/70" : "border-white shadow-sm",
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          )}
          {strokes.length > 0 && (
            <ToolButton label="Clear my notes" onClick={() => onStrokesChange([])}>
              <Trash2 className="size-4" />
            </ToolButton>
          )}
        </div>

        <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-black/10 bg-white/90 p-1 shadow-sm backdrop-blur">
          <ToolButton label="Zoom out" onClick={() => zoomCenter(1 / 1.4)} disabled={view.k <= 1} hideOnPhone>
            <Minus className="size-4" />
          </ToolButton>
          <ToolButton label="Zoom in" onClick={() => zoomCenter(1.4)} disabled={view.k >= MAX_ZOOM} hideOnPhone>
            <Plus className="size-4" />
          </ToolButton>
          <ToolButton label="Fit to screen" onClick={() => setView({ k: 1, x: 0, y: 0 })} disabled={view.k === 1}>
            <Scan className="size-4" />
          </ToolButton>
          <ToolButton label={isFullscreen ? "Exit full screen" : "Full screen"} onClick={onToggleFullscreen}>
            {isFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </ToolButton>
        </div>
      </div>
    </div>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  disabled,
  hideOnPhone,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  hideOnPhone?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded-lg text-zinc-700 transition-colors hover:bg-zinc-900/8 disabled:opacity-35 disabled:hover:bg-transparent sm:size-8",
        hideOnPhone && "max-sm:hidden",
        active && "bg-zinc-900 text-white hover:bg-zinc-900",
      )}
    >
      {children}
    </button>
  );
}
