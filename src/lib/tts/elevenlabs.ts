import { env } from "@/lib/env";
import type { SceneTiming } from "@/lib/lesson/types";
import { wordsFromAlignment, type CharAlignment } from "./align";

export type TtsErrorCode = "quota" | "config" | "unavailable" | "invalid";

export class TtsError extends Error {
  constructor(
    message: string,
    public readonly code: TtsErrorCode,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export interface SynthesizedScene {
  audio: Buffer;
  mime: string;
  timing: SceneTiming;
  /** Characters billed by the provider (for logging). */
  chars: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Synthesize one scene's narration with ElevenLabs, returning MP3 audio plus word-level timing
 * so the whiteboard can be synchronized to the voice.
 */
export async function synthesizeScene(text: string): Promise<SynthesizedScene> {
  const { ELEVENLABS_API_KEY: key, ELEVENLABS_VOICE_ID: voice, ELEVENLABS_MODEL: model } = env();
  if (!key) throw new TtsError("Voice is not configured.", "config");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_64`;
  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
  });

  let last: TtsError | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      last = new TtsError("Could not reach the voice service.", "unavailable");
      continue;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let detail: { status?: string; code?: string; message?: string } = {};
      try {
        detail = (JSON.parse(raw) as { detail?: typeof detail }).detail ?? {};
      } catch {
        /* non-JSON error body */
      }
      const tag = `${detail.status ?? ""} ${detail.code ?? ""}`;
      if (/quota_exceeded|insufficient|payment_required|paid_plan|character_limit/i.test(tag) || res.status === 402) {
        throw new TtsError("The voice quota has been used up.", "quota");
      }
      if (res.status === 401 || res.status === 403) {
        throw new TtsError("The voice API key was rejected or lacks permission.", "config");
      }
      if (res.status === 429 || res.status >= 500) {
        last = new TtsError("The voice service is busy.", "unavailable");
        continue;
      }
      console.error(`[tts] HTTP ${res.status}: ${raw.slice(0, 300)}`);
      throw new TtsError("The voice service could not process this text.", "invalid");
    }

    const data = (await res.json()) as {
      audio_base64?: string;
      alignment?: CharAlignment | null;
      normalized_alignment?: CharAlignment | null;
    };
    if (!data.audio_base64) throw new TtsError("The voice service returned no audio.", "invalid");
    const alignment = data.alignment ?? data.normalized_alignment;
    if (!alignment) throw new TtsError("The voice service returned no timing data.", "invalid");
    try {
      return {
        audio: Buffer.from(data.audio_base64, "base64"),
        mime: "audio/mpeg",
        timing: wordsFromAlignment(text, alignment),
        chars: text.length,
      };
    } catch {
      throw new TtsError("The voice timing data was unusable.", "invalid");
    }
  }
  throw last ?? new TtsError("The voice service failed.", "unavailable");
}
