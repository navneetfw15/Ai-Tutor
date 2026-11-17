"use client";

import { memo } from "react";
import type { TimedItem } from "@/lib/lesson/timeline";
import { piecesFor, type Piece } from "@/lib/whiteboard/draw";
import { BOARD_BG } from "@/lib/whiteboard/palette";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const local = (p: number, from: number, to: number) => (to <= from ? (p >= to ? 1 : 0) : clamp01((p - from) / (to - from)));

function PieceView({ piece, progress, id }: { piece: Piece; progress: number; id: string }) {
  const lp = local(progress, piece.from, piece.to);
  if (lp <= 0) return null;

  switch (piece.t) {
    case "stroke": {
      if (piece.dashed) {
        return (
          <path
            d={piece.d}
            fill="none"
            stroke={piece.color}
            strokeWidth={piece.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="16 13"
            opacity={ease(lp)}
          />
        );
      }
      const done = lp >= 1;
      return (
        <path
          d={piece.d}
          fill="none"
          stroke={piece.color}
          strokeWidth={piece.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          // Draw-on effect: normalise the path length to 1 and reveal it with the dash offset.
          pathLength={done ? undefined : 1}
          strokeDasharray={done ? undefined : 1}
          strokeDashoffset={done ? undefined : 1 - lp}
        />
      );
    }

    case "fill":
      return <path d={piece.d} fill={piece.color} stroke="none" opacity={piece.opacity * ease(lp)} />;

    case "dot":
      return <circle cx={piece.cx} cy={piece.cy} r={piece.r * ease(lp)} fill={piece.color} stroke="#fff" strokeWidth={2.5} />;

    case "rect":
      return (
        <rect
          x={piece.x}
          y={piece.y}
          width={piece.w * ease(lp)}
          height={piece.h}
          rx={piece.rx}
          fill={piece.color}
          opacity={piece.opacity}
          style={piece.multiply ? { mixBlendMode: "multiply" } : undefined}
        />
      );

    case "text": {
      const lineH = piece.px * 1.22;
      const text = (
        <text
          className="board-text"
          fontSize={piece.px}
          fontWeight={piece.weight}
          textAnchor={piece.anchor}
          dominantBaseline="central"
          fill={piece.color}
          stroke={piece.halo ? BOARD_BG : undefined}
          strokeWidth={piece.halo ? piece.px * 0.3 : undefined}
          strokeLinejoin="round"
          paintOrder={piece.halo ? "stroke" : undefined}
        >
          {piece.lines.map((line, i) => (
            <tspan key={i} x={piece.x} y={piece.y + i * lineH}>
              {line}
            </tspan>
          ))}
        </text>
      );
      if (piece.pop) {
        const s = 0.55 + 0.45 * ease(lp);
        const cy = piece.y + ((piece.lines.length - 1) * lineH) / 2;
        return (
          <g opacity={clamp01(lp * 1.6)} transform={`translate(${piece.x} ${cy}) scale(${s}) translate(${-piece.x} ${-cy})`}>
            {text}
          </g>
        );
      }
      if (lp >= 1 || !piece.clip) return text;
      // Left-to-right "writing" reveal.
      const c = piece.clip;
      const clipId = `clip-${id}`;
      return (
        <>
          <clipPath id={clipId}>
            <rect x={c.x0} y={c.y0 - 10} width={(c.x1 - c.x0) * ease(lp)} height={c.y1 - c.y0 + 20} />
          </clipPath>
          <g clipPath={`url(#${clipId})`}>{text}</g>
        </>
      );
    }
  }
}

interface Props {
  item: TimedItem;
  progress: number;
  opacity: number;
}

/** One whiteboard element. Memoised: fully drawn elements do not re-render every frame. */
export const BoardItem = memo(
  function BoardItem({ item, progress, opacity }: Props) {
    const pieces = piecesFor(item);
    const safe = item.key.replace(/[^\w-]/g, "_");
    return (
      <g opacity={opacity} data-id={item.action.id}>
        {pieces.map((piece, i) => (
          <PieceView key={i} piece={piece} progress={progress} id={`${safe}-${i}`} />
        ))}
      </g>
    );
  },
  (a, b) => a.item === b.item && a.progress === b.progress && a.opacity === b.opacity,
);
