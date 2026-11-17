import { z } from "zod";
import { generateAnswer } from "@/lib/ai/generate";
import { ApiError, enforceLimit, handle, ok, parseBody } from "@/lib/api";
import { db } from "@/lib/db/client";
import { getLessonDTO, messageToDTO, nextSeq } from "@/lib/db/queries";
import { messages } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { ensureOwnerId } from "@/lib/session";

export const maxDuration = 90;

const MAX_MESSAGES_PER_LESSON = 40;

const bodySchema = z.object({
  text: z
    .string()
    .trim()
    .min(2, "Type your question first.")
    .max(500, "Please keep your question under 500 characters."),
  /** Scene the learner was watching when they asked. */
  sceneIndex: z.number().int().min(0).max(20).optional(),
  /** The last thing the tutor said before the learner paused. */
  spokenSoFar: z.string().max(400).optional(),
});

export async function POST(req: Request, ctx: RouteContext<"/api/lessons/[id]/messages">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await parseBody(req, bodySchema);
    const ownerId = await ensureOwnerId();

    const lesson = await getLessonDTO(id, ownerId);
    if (!lesson) throw new ApiError(404, "not_found", "We couldn't find that lesson.");
    if (!lesson.isOwner) {
      throw new ApiError(403, "forbidden", "Only the person who created this lesson can ask follow-up questions. Start your own lesson to chat!");
    }
    if (lesson.messages.length >= MAX_MESSAGES_PER_LESSON) {
      throw new ApiError(409, "conversation_full", "This conversation is getting long. Start a new lesson to keep learning!");
    }
    const script = lesson.messages.find((m) => m.script && m.script.scenes.length > 0)?.script;
    if (!script) throw new ApiError(409, "no_lesson", "This lesson has no content to ask about.");

    const config = env();
    await enforceLimit("message", ownerId, req, config.RATE_LIMIT_MESSAGES_PER_HOUR);

    const generated = await generateAnswer({
      script,
      sceneIndex: Math.min(body.sceneIndex ?? 0, script.scenes.length - 1),
      spokenSoFar: body.spokenSoFar,
      history: lesson.messages.map((m) => ({ role: m.role, text: m.text })),
      question: body.text,
    });

    const answer = generated.script;
    const hasScenes = answer.scenes.length > 0;
    const seq = await nextSeq(id);
    const userId = newId();
    const assistantId = newId();
    const [userRows, assistantRows] = await db().batch([
      db().insert(messages).values({ id: userId, lessonId: id, seq, role: "user", text: body.text }).returning(),
      db()
        .insert(messages)
        .values({
          id: assistantId,
          lessonId: id,
          seq: seq + 1,
          role: "assistant",
          text: generated.refusal ?? (answer.summary || answer.title),
          script: hasScenes ? answer : null,
          suggestions: answer.suggestions,
          voiceMode: hasScenes && config.ttsProvider === "elevenlabs" ? "eleven" : "browser",
        })
        .returning(),
    ]);
    console.info(`[answer] lesson=${id} ${(generated.ms / 1000).toFixed(1)}s scenes=${answer.scenes.length} words=${generated.words}`);

    return ok({ user: messageToDTO(userRows[0], []), assistant: messageToDTO(assistantRows[0], []) }, { status: 201 });
  });
}
