"use client";

import { useEngineState } from "@/lib/client/hooks";
import { speechAt, type Timeline } from "@/lib/lesson/timeline";
import type { PlaybackEngine } from "@/lib/playback/engine";

interface Props {
  engine: PlaybackEngine;
  timeline: Timeline | null;
}

/** Live karaoke-style captions: the sentence being spoken, with the current word highlighted. */
export function Captions({ engine, timeline }: Props) {
  const time = useEngineState(engine, (s) => s.time);
  const playing = useEngineState(engine, (s) => s.playing);

  let content: React.ReactNode = null;
  if (timeline && timeline.scenes.length > 0) {
    const pos = speechAt(timeline, time);
    const scene = timeline.scenes[pos.scene];
    const beat = scene?.beats[pos.beat];
    if (scene && beat) {
      const words = scene.words.slice(beat.w0, beat.w1);
      // One block-level paragraph: spaces between inline spans would collapse inside a flex container.
      content = (
        <p className="text-balance">
          {words.map((w, i) => {
            const idx = beat.w0 + i;
            const state = idx < pos.word ? "spoken" : idx === pos.word ? "current" : "upcoming";
            return (
              <span
                key={idx}
                className={
                  state === "current"
                    ? "rounded-md bg-accent/15 text-fg"
                    : state === "spoken"
                      ? "text-fg"
                      : "text-faint"
                }
              >
                {w.text}{" "}
              </span>
            );
          })}
        </p>
      );
    }
  }

  return (
    <div
      className="flex min-h-[3.4rem] items-center justify-center rounded-xl border border-line bg-surface px-4 py-2.5 text-center text-[15px] leading-snug font-medium shadow-soft sm:text-lg"
      aria-live="off"
      data-testid="captions"
      data-playing={playing}
    >
      {content ?? <span className="text-sm font-normal text-faint">Captions appear here while the tutor speaks.</span>}
    </div>
  );
}
