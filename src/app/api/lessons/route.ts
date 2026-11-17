import { z } from "zod";
import { generateLesson } from "@/lib/ai/generate";
import { ApiError, enforceLimit, handle, ok, parseBody } from "@/lib/api";
import { db } from "@/lib/db/client";
import { listLessons } from "@/lib/db/queries";
import { lessons, messages } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { ensureOwnerId, readOwnerId } from "@/lib/session";

// Lesson generation calls an LLM and can take a while (typically 15-45s; slower when the API is busy).
export const maxDuration = 120;

const createSchema = z.object({
  topic: z
    .string()
    .trim()
    .min(3, "Tell me a little more about what you'd like to learn.")
    .max(200, "Please keep the topic under 200 characters."),
});

export async function GET() {
  return handle(async () => {
    const ownerId = await readOwnerId();
    return ok({ lessons: ownerId ? await listLessons(ownerId) : [] });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { topic: rawTopic } = await parseBody(req, createSchema);
    // Collapse whitespace/control characters; the topic is only ever used as quoted data in prompts.
    const topic = rawTopic.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(topic)) {
      throw new ApiError(400, "bad_request", "Please enter a topic using words or numbers.");
    }

    const ownerId = await ensureOwnerId();
    const config = env();
    await enforceLimit("lesson", ownerId, req, config.RATE_LIMIT_LESSONS_PER_HOUR);

    const generated = await generateLesson(topic);
    if (generated.refusal) return ok({ refusal: generated.refusal });

    const lessonId = newId();
    const messageId = newId();
    const { script } = generated;
    await db().batch([
      db().insert(lessons).values({ id: lessonId, ownerId, topic, title: script.title }),
      db().insert(messages).values({
        id: messageId,
        lessonId,
        seq: 1,
        role: "assistant",
        text: script.summary || script.title,
        script,
        suggestions: script.suggestions,
        voiceMode: config.ttsProvider === "elevenlabs" ? "eleven" : "browser",
      }),
    ]);
    console.info(
      `[lesson] ${lessonId} model=${generated.model} ${(generated.ms / 1000).toFixed(1)}s words=${generated.words} scenes=${script.scenes.length} warnings=${generated.warnings.length}`,
    );
    return ok({ lessonId }, { status: 201 });
  });
}
