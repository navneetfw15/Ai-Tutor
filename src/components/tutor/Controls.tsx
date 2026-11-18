"use client";

import { Captions, FastForward, Loader2, Pause, Play, RotateCcw, Rewind, Volume2, VolumeX } from "lucide-react";
import { useRef } from "react";
import { useEngineState, type Prefs } from "@/lib/client/hooks";
import type { Timeline } from "@/lib/lesson/timeline";
import type { PlaybackEngine } from "@/lib/playback/engine";
import { cn, formatTime } from "@/lib/utils";

const RATES = [0.75, 1, 1.25, 1.5, 2];

interface Props {
  engine: PlaybackEngine;
  timeline: Timeline | null;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
}

export function Controls({ engine, timeline, prefs, onPrefs }: Props) {
  const time = useEngineState(engine, (s) => s.time);
  const duration = useEngineState(engine, (s) => s.duration);
  const playing = useEngineState(engine, (s) => s.playing);
  const buffering = useEngineState(engine, (s) => s.buffering);
  const ended = useEngineState(engine, (s) => s.ended);
  const loaded = useEngineState(engine, (s) => s.loaded);
  const muted = useEngineState(engine, (s) => s.muted);
  const rate = useEngineState(engine, (s) => s.rate);

  const wasPlaying = useRef(false);
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;

  const startScrub = () => {
    wasPlaying.current = engine.getSnapshot().playing;
    if (wasPlaying.current) engine.pause();
  };
  const endScrub = () => {
    if (wasPlaying.current) engine.play();
    wasPlaying.current = false;
  };

  return (
    <div
      className="rounded-2xl border border-line bg-surface px-3 py-2 shadow-soft max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:gap-x-2 max-sm:gap-y-1 sm:p-4"
      role="group"
      aria-label="Lesson player"
    >
      {/* Scrubber with chapter ticks. On phones the time sits at the end of this row. */}
      <div className="relative max-sm:col-start-1 max-sm:row-start-1">
        <input
          type="range"
          className="scrub"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={10}
          value={Math.round(time)}
          disabled={!loaded}
          aria-label="Seek"
          aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
          style={{ ["--pct" as string]: `${pct}%` }}
          onPointerDown={startScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onChange={(e) => engine.seek(Number(e.target.value))}
          data-testid="scrubber"
        />
        {timeline && duration > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[6px] -translate-y-1/2" aria-hidden>
            {timeline.scenes.slice(1).map((s) => (
              <span
                key={s.index}
                className="absolute top-0 h-full w-[3px] -translate-x-1/2 rounded-full bg-white/80 mix-blend-overlay"
                style={{ left: `${(s.start / duration) * 100}%` }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-1 flex items-center gap-x-1.5 max-sm:contents sm:gap-x-2">
        <div className="flex items-center gap-1 max-sm:col-start-1 max-sm:row-start-2 max-sm:gap-0.5">
          <IconBtn label="Restart" onClick={() => engine.restart()} disabled={!loaded}>
            <RotateCcw className="size-[18px]" />
          </IconBtn>
          <IconBtn label="Back 5 seconds" onClick={() => engine.seekBy(-5000)} disabled={!loaded}>
            <Rewind className="size-[18px]" />
          </IconBtn>
          <button
            type="button"
            onClick={() => engine.toggle()}
            disabled={!loaded}
            aria-label={playing ? "Pause" : ended ? "Replay" : "Play"}
            data-testid="play-pause"
            className="btn-primary mx-0.5 grid size-11 shrink-0 place-items-center rounded-full transition-transform sm:mx-1 sm:size-12"
          >
            {buffering && playing ? (
              <Loader2 className="size-5 animate-spin" />
            ) : playing ? (
              <Pause className="size-5 fill-current" />
            ) : ended ? (
              <RotateCcw className="size-5" />
            ) : (
              <Play className="ml-0.5 size-5 fill-current" />
            )}
          </button>
          <IconBtn label="Forward 5 seconds" onClick={() => engine.seekBy(5000)} disabled={!loaded}>
            <FastForward className="size-[18px]" />
          </IconBtn>
        </div>

        <div
          className="ml-1 min-w-[4.6rem] text-[13px] tabular-nums text-muted max-sm:col-start-2 max-sm:row-start-1 max-sm:ml-0 max-sm:min-w-0 max-sm:text-right sm:min-w-[5.5rem] sm:text-sm"
          data-testid="time-label"
        >
          <span className="font-medium text-fg">{formatTime(time)}</span> / {formatTime(duration)}
        </div>

        <div className="ml-auto flex items-center gap-1 max-sm:col-start-2 max-sm:row-start-2">
          <label className="relative">
            <span className="sr-only">Playback speed</span>
            <select
              value={rate}
              onChange={(e) => {
                const r = Number(e.target.value);
                engine.setRate(r);
                onPrefs({ rate: r });
              }}
              className="h-9 cursor-pointer appearance-none rounded-lg border border-line bg-surface-2 px-2.5 text-sm font-medium text-fg hover:border-accent/50 sm:px-3"
              aria-label="Playback speed"
              data-testid="speed"
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
          <IconBtn
            label={muted ? "Unmute" : "Mute"}
            hideOnPhone
            pressed={muted}
            onClick={() => {
              engine.setMuted(!muted);
              onPrefs({ muted: !muted });
            }}
          >
            {muted ? <VolumeX className="size-[18px]" /> : <Volume2 className="size-[18px]" />}
          </IconBtn>
          <IconBtn
            label={prefs.captions ? "Hide captions" : "Show captions"}
            pressed={prefs.captions}
            onClick={() => onPrefs({ captions: !prefs.captions })}
          >
            <Captions className="size-[18px]" />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  pressed,
  hideOnPhone,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  hideOnPhone?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40",
        hideOnPhone && "max-sm:hidden",
        pressed && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent",
      )}
    >
      {children}
    </button>
  );
}
