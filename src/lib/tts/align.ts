import type { SceneTiming, WordTiming } from "@/lib/lesson/types";

/** Character-level alignment as returned by ElevenLabs `/with-timestamps`. */
export interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Silence kept after the last spoken character so the final drawing can finish. */
const TAIL_MS = 250;

/**
 * Convert per-character timing into per-word timing for `text`.
 * `text` is exactly what was sent to the TTS API, so word offsets index straight into it.
 */
export function wordsFromAlignment(text: string, alignment: CharAlignment): SceneTiming {
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  const n = Math.min(alignment.characters.length, starts.length, ends.length);
  if (n === 0) throw new Error("Empty alignment");

  // Normally the alignment has one entry per character of the input. If the provider normalised
  // the text, fall back to a proportional mapping so timing stays roughly right.
  const exact = n === text.length;
  const ratio = n / Math.max(1, text.length);
  const idx = (i: number) => (exact ? i : Math.min(n - 1, Math.max(0, Math.floor(i * ratio))));

  const words: WordTiming[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let prevStart = 0;
  while ((m = re.exec(text))) {
    const c0 = m.index;
    const c1 = m.index + m[0].length;
    let s = Math.round(starts[idx(c0)] * 1000);
    let e = Math.round(ends[idx(c1 - 1)] * 1000);
    if (s < prevStart) s = prevStart;
    if (e < s) e = s;
    prevStart = s;
    words.push([c0, c1, s, e]);
  }
  if (words.length === 0) throw new Error("No words in text");

  const lastEnd = Math.round(Math.max(...ends.slice(0, n)) * 1000);
  return { words, durationMs: Math.max(lastEnd, words[words.length - 1][3]) + TAIL_MS };
}
