import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, enforceLimit, handle, ok, parseBody } from "@/lib/api";
import { db } from "@/lib/db/client";
import { clipToDTO, getAudioContext, getClipMeta } from "@/lib/db/queries";
import { clips, messages } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { sceneText } from "@/lib/lesson/types";
import { ensureOwnerId } from "@/lib/session";
import { synthesizeScene, TtsError } from "@/lib/tts/elevenlabs";

export const maxDuration = 60;

const bodySchema = z.object({ scene: z.number().int().min(0).max(20) });

/**
 * Returns the narration clip (MP3 + word timings) for one scene of a message, generating it with
 * text-to-speech on first request. If the voice provider is unavailable the message is switched to
 * "browser" voice mode so the lesson still plays.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/messages/[id]/audio">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { scene: sceneIndex } = await parseBody(req, bodySchema);
    const ownerId = await ensureOwnerId();

    const { row, clip: existing } = await getAudioContext(id, sceneIndex);
    if (!row) throw new ApiError(404, "not_found", "Message not found.");
    if (row.ownerId !== ownerId) throw new ApiError(403, "forbidden", "Only the lesson owner can generate narration.");
    const { message } = row;
    const scene = message.script?.scenes[sceneIndex];
    if (!scene) throw new ApiError(404, "not_found", "Scene not found.");

    if (message.voiceMode === "browser") return ok({ voiceMode: "browser" });

    if (existing) return ok({ voiceMode: "eleven", clip: clipToDTO(existing) });

    const config = env();
    if (config.ttsProvider !== "elevenlabs") {
      await db().update(messages).set({ voiceMode: "browser" }).where(eq(messages.id, id));
      return ok({ voiceMode: "browser", reason: "voice_not_configured" });
    }
    await enforceLimit("audio", ownerId, req, config.RATE_LIMIT_AUDIO_PER_HOUR);

    try {
      const text = sceneText(scene);
      const out = await synthesizeScene(text);
      const [inserted] = await db()
        .insert(clips)
        .values({
          id: newId(),
          messageId: id,
          sceneIndex,
          audio: out.audio,
          mime: out.mime,
          bytes: out.audio.length,
          durationMs: out.timing.durationMs,
          words: out.timing.words,
        })
        .onConflictDoNothing()
        .returning({
          id: clips.id,
          messageId: clips.messageId,
          sceneIndex: clips.sceneIndex,
          durationMs: clips.durationMs,
          words: clips.words,
        });
      // On a race (another request stored this scene first) read the winner instead.
      const saved = inserted ?? (await getClipMeta(id, sceneIndex));
      if (!saved) throw new ApiError(500, "internal", "Could not save the narration.");
      console.info(`[tts] message=${id} scene=${sceneIndex} chars=${out.chars} bytes=${out.audio.length} duration=${out.timing.durationMs}ms`);
      return ok({ voiceMode: "eleven", clip: clipToDTO(saved) });
    } catch (err) {
      if (err instanceof TtsError) {
        console.warn(`[tts] falling back to browser voice for message=${id}: ${err.code} - ${err.message}`);
        await db().update(messages).set({ voiceMode: "browser" }).where(eq(messages.id, id));
        return ok({ voiceMode: "browser", reason: `tts_${err.code}` });
      }
      throw err;
    }
  });
}
