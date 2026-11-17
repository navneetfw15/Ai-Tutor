import { checkLessonQuality, sanitizeScript, ScriptError } from "@/lib/lesson/sanitize";
import { scriptWordCount, type Script } from "@/lib/lesson/types";
import { AiError, generateJson } from "./gemini";
import {
  ANSWER_SYSTEM_PROMPT,
  LESSON_SYSTEM_PROMPT,
  answerUserPrompt,
  lessonUserPrompt,
  type AnswerContext,
} from "./prompts";
import { lessonResponseSchema } from "./schema";

export interface Generated {
  script: Script;
  /** Set when the model declined the request; `script.scenes` is then empty. */
  refusal?: string;
  words: number;
  warnings: string[];
  model: string;
  ms: number;
}

function refusalOf(json: unknown): string | undefined {
  if (typeof json === "object" && json && "refusal" in json) {
    const r = (json as { refusal?: unknown }).refusal;
    if (typeof r === "string" && r.trim().length > 3) return r.trim().slice(0, 300);
  }
  return undefined;
}

/** Quality score used to pick the better of two attempts (lower is better). */
function penalty(problems: number, words: number): number {
  return problems * 100 + Math.abs(words - 300);
}

export async function generateLesson(topic: string): Promise<Generated> {
  const base = lessonUserPrompt(topic);
  let best: (Generated & { problems: string[] }) | undefined;
  let feedback = "";
  let lastError: unknown;
  // One time budget for all attempts (the API route allows 120s).
  const deadline = Date.now() + 100_000;
  /** A second full generation takes 15-45s; only start one if there is room for it. */
  const roomForRetry = () => deadline - Date.now() > 40_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && !roomForRetry()) break;
    try {
      const out = await generateJson({
        system: LESSON_SYSTEM_PROMPT,
        user: base + feedback,
        schema: lessonResponseSchema,
        temperature: attempt === 0 ? 0.8 : 0.6,
        deadline,
      });
      const refusal = refusalOf(out.json);
      if (refusal) {
        const { script } = sanitizeScript({ ...(out.json as object), scenes: [] }, { mode: "answer" });
        return { script, refusal, words: 0, warnings: [], model: out.model, ms: out.ms };
      }
      const { script, warnings } = sanitizeScript(out.json, { mode: "lesson" });
      const quality = checkLessonQuality(script);
      const candidate = { script, words: quality.words, warnings, model: out.model, ms: out.ms, problems: quality.problems };
      console.info(
        `[lesson] attempt ${attempt + 1}: ${(out.ms / 1000).toFixed(1)}s words=${quality.words} tokens=${out.usage?.outputTokens ?? "?"}+${out.usage?.thoughtTokens ?? 0}t problems=${quality.problems.length ? quality.problems.join(" | ") : "none"}`,
      );
      if (!best || penalty(candidate.problems.length, candidate.words) < penalty(best.problems.length, best.words)) {
        best = candidate;
      }
      if (quality.problems.length === 0) break;
      feedback = `\n\nYour previous attempt had these problems, fix them: ${quality.problems.join("; ")}. Return the complete corrected JSON.`;
    } catch (err) {
      lastError = err;
      // Hard API failures (rate limit, config, blocked) will not improve on a retry.
      if (err instanceof AiError && err.code !== "invalid") throw err;
      feedback = "\n\nYour previous reply was not usable. Return a complete, valid lesson as specified.";
    }
  }

  if (!best) {
    if (lastError instanceof AiError) throw lastError;
    throw new AiError(
      lastError instanceof ScriptError ? "The AI produced an unusable lesson. Please try again." : "The AI request failed.",
      "invalid",
    );
  }
  // A lesson that is off in length is still far better than an error: when only a small fast model
  // is available it writes short lessons, and that is an acceptable degraded mode. Only reject
  // output that is essentially empty or runaway.
  if (best.words < 70 || best.words > 800) {
    throw new AiError("The AI produced a lesson of the wrong length. Please try again.", "invalid");
  }
  const { problems, ...result } = best;
  if (problems.length) result.warnings.push(`quality: ${problems.join("; ")}`);
  return result;
}

export async function generateAnswer(ctx: AnswerContext): Promise<Generated> {
  const out = await generateJson({
    system: ANSWER_SYSTEM_PROMPT,
    user: answerUserPrompt(ctx),
    schema: lessonResponseSchema,
    temperature: 0.7,
    maxOutputTokens: 8000,
    thinking: "minimal",
    perCallTimeoutMs: 30_000, // a short answer should take ~5s; a stuck model must not hold the learner
  });
  const refusal = refusalOf(out.json);
  let script: Script;
  let warnings: string[];
  try {
    ({ script, warnings } = sanitizeScript(out.json, { mode: "answer" }));
  } catch (err) {
    throw new AiError(err instanceof Error ? err.message : "The AI produced an unusable answer.", "invalid");
  }
  if (refusal) script.scenes = [];
  if (!script.summary && script.scenes.length === 0 && !refusal) {
    throw new AiError("The AI returned an empty answer. Please try again.", "invalid");
  }
  return { script, refusal, words: scriptWordCount(script), warnings, model: out.model, ms: out.ms };
}
