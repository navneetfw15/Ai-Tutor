import type { SceneTiming, WordTiming } from "./types";

/**
 * Estimated speech timing, used when there is no recorded audio (browser voice mode) or when a
 * provider returns no alignment. Calibrated to roughly 150 words per minute.
 */
export function estimateSceneTiming(text: string, speed = 1): SceneTiming {
  const words: WordTiming[] = [];
  const re = /\S+/g;
  let t = 150; // leading breath
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = m[0];
    const letters = word.replace(/[^\p{L}\p{N}]/gu, "").length;
    const dur = 300 + Math.max(0, letters - 4) * 36;
    words.push([m.index, m.index + word.length, Math.round(t / speed), Math.round((t + dur) / speed)]);
    let pause = 0;
    if (/[.!?…]["')]?$/.test(word)) pause = 420;
    else if (/[,;:]["')]?$/.test(word)) pause = 200;
    t += dur + 40 + pause;
  }
  return { durationMs: Math.round((t + 250) / speed), words };
}
