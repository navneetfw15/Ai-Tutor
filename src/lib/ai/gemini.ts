import { env } from "@/lib/env";

/**
 * Minimal Gemini client (REST). Kept dependency-free on purpose: one function, structured JSON
 * output, a model fallback chain and typed errors the API layer can turn into friendly messages.
 * To use another provider, replace `generateJson` - nothing else in the app talks to an LLM.
 *
 * Reliability design:
 *  - Google's free tier is limited per model per day, and models sometimes return 503 "high demand"
 *    or simply hang under load. Quotas are tracked per model, so trying the next model keeps the app
 *    working when the first is exhausted, busy or stuck.
 *  - Requests are streamed. A model that sends nothing for FIRST_CHUNK_TIMEOUT_MS is hung and is
 *    abandoned quickly; one that is streaming (just slowly) is allowed to finish.
 *  - Every model gets a slice of one overall time budget, with time reserved for the fallbacks.
 */

export type AiErrorCode = "rate_limited" | "unavailable" | "blocked" | "invalid" | "config";

export class AiError extends Error {
  constructor(
    message: string,
    public readonly code: AiErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface GenerateJsonInput {
  system: string;
  user: string;
  /** JSON Schema (Gemini `responseJsonSchema`). */
  schema: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  /** How much the model may think before answering (default "low"). */
  thinking?: "minimal" | "low";
  /** Absolute time (Date.now() based) by which the whole call must have finished. */
  deadline?: number;
  /** Max time one (non-final) model may take; short answers should fail over faster than lessons. */
  perCallTimeoutMs?: number;
}

export interface GenerateJsonResult {
  json: unknown;
  usage?: { promptTokens?: number; outputTokens?: number; thoughtTokens?: number };
  model: string;
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_BUDGET_MS = 80_000;
/** A model that is still generating after this long is treated as stuck, so the fallbacks get a turn. */
const PER_CALL_TIMEOUT_MS = 50_000;
/** The last model may use whatever time is left, up to this. */
const LAST_CALL_TIMEOUT_MS = 70_000;
/** A model that sends nothing at all for this long is hung. */
const FIRST_CHUNK_TIMEOUT_MS = 25_000;
/** Time kept in reserve for each model still waiting in the chain (fast models need ~10s). */
const RESERVE_PER_FALLBACK_MS = 12_000;
/** A rate-limit wait longer than this is not worth holding the visitor for. */
const MAX_RATE_WAIT_MS = 15_000;

function thinkingConfig(model: string, level: "minimal" | "low"): Record<string, unknown> | undefined {
  // Gemini 3.x models take a thinking *level*. A little thinking helps layout planning; a lot only
  // adds latency.
  return /gemini-3/.test(model) ? { thinkingLevel: level } : undefined;
}

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

type Outcome =
  | { kind: "ok"; result: GenerateJsonResult }
  /** Same model might work if we wait briefly. */
  | { kind: "retry"; error: AiError; waitMs: number; lowerThinking?: boolean }
  /** This model cannot serve the request now; try the next one. */
  | { kind: "skip"; error: AiError; dailyQuota?: boolean }
  /** No model will do better (bad key, blocked content). */
  | { kind: "fatal"; error: AiError };

interface RequestParts {
  key: string;
  body: string;
}

interface StreamChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
}

const EVENT_BREAK = /\r?\n\r?\n/;

function classifyHttpError(model: string, status: number, detail: string): Outcome {
  if (status === 400 && /API key|API_KEY/i.test(detail)) {
    return { kind: "fatal", error: new AiError("The AI API key is invalid.", "config", 400) };
  }
  if (status === 401 || status === 403) {
    return { kind: "fatal", error: new AiError("The AI API key was rejected.", "config", status) };
  }
  if (status === 429) {
    const daily = /PerDay|per day/i.test(detail);
    const hint = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(detail);
    const waitMs = hint ? Math.ceil(Number(hint[1]) * 1000) + 250 : 3000;
    const error = new AiError("The AI is busy right now (rate limit). Please try again in a minute.", "rate_limited", 429);
    if (!daily && waitMs <= MAX_RATE_WAIT_MS) return { kind: "retry", error, waitMs };
    return { kind: "skip", error, dailyQuota: daily };
  }
  if (status >= 500) {
    return { kind: "retry", waitMs: 1500, error: new AiError("The AI service is temporarily unavailable.", "unavailable", status) };
  }
  if (status === 400 && /thinking level/i.test(detail)) {
    // e.g. "Thinking level MINIMAL is not supported for this model": same model, gentler setting.
    return { kind: "retry", waitMs: 0, lowerThinking: true, error: new AiError("Thinking level not supported.", "invalid", 400) };
  }
  // 404 (model retired) or 400 (this model rejects the request shape): another model may accept it.
  console.warn(`[gemini] ${model} HTTP ${status}: ${detail.slice(0, 200).replace(/\s+/g, " ")}`);
  return { kind: "skip", error: new AiError("The AI could not process this request.", "invalid", status) };
}

async function callModel(model: string, req: RequestParts, timeoutMs: number, started: number): Promise<Outcome> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const controller = new AbortController();
  let aborted: "overall" | "silent" | null = null;
  const overall = setTimeout(() => {
    aborted = "overall";
    controller.abort();
  }, timeoutMs);
  const silence = setTimeout(
    () => {
      aborted = "silent";
      controller.abort();
    },
    Math.min(FIRST_CHUNK_TIMEOUT_MS, timeoutMs),
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": req.key },
      body: req.body,
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(silence);
      return classifyHttpError(model, res.status, await res.text().catch(() => ""));
    }
    if (!res.body) {
      return { kind: "retry", waitMs: 500, error: new AiError("The AI returned an empty answer.", "invalid") };
    }

    // Read the server-sent events, accumulating the model's visible text.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    let usage: StreamChunk["usageMetadata"];
    let streamError: string | undefined;
    let gotData = false;

    const handleEvent = (raw: string) => {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          continue; // a damaged event; the final JSON check catches real damage
        }
        if (chunk.error) streamError = chunk.error.message ?? "stream error";
        if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (!part.thought && typeof part.text === "string") text += part.text;
        }
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!gotData) {
        gotData = true;
        clearTimeout(silence); // it is alive; only the overall limit applies from here
      }
      buffer += decoder.decode(value, { stream: true });
      for (let m = EVENT_BREAK.exec(buffer); m; m = EVENT_BREAK.exec(buffer)) {
        handleEvent(buffer.slice(0, m.index));
        buffer = buffer.slice(m.index + m[0].length);
      }
    }
    if (buffer.trim()) handleEvent(buffer);

    const blocked = new AiError("This topic can't be turned into a lesson. Try rephrasing it.", "blocked");
    if (blockReason) return { kind: "fatal", error: blocked };
    if (streamError) {
      return { kind: "retry", waitMs: 1000, error: new AiError("The AI service had a problem.", "unavailable") };
    }
    if (!text) {
      if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") return { kind: "fatal", error: blocked };
      return { kind: "retry", waitMs: 500, error: new AiError("The AI returned an empty answer.", "invalid") };
    }
    try {
      return {
        kind: "ok",
        result: {
          json: JSON.parse(stripFences(text)),
          model,
          ms: Date.now() - started,
          usage: {
            promptTokens: usage?.promptTokenCount,
            outputTokens: usage?.candidatesTokenCount,
            thoughtTokens: usage?.thoughtsTokenCount,
          },
        },
      };
    } catch {
      const tooLong = finishReason === "MAX_TOKENS";
      return {
        kind: "skip",
        error: new AiError(tooLong ? "The lesson was too long to generate." : "The AI returned malformed data.", "invalid"),
      };
    }
  } catch {
    if (aborted) {
      console.warn(`[gemini] ${model}: ${aborted === "silent" ? "no response" : "too slow"} - giving up on it`);
      return { kind: "skip", error: new AiError("The AI took too long to respond.", "unavailable") };
    }
    return { kind: "retry", waitMs: 1000, error: new AiError("Could not reach the AI service.", "unavailable") };
  } finally {
    clearTimeout(overall);
    clearTimeout(silence);
  }
}

export async function generateJson(input: GenerateJsonInput): Promise<GenerateJsonResult> {
  const config = env();
  const started = Date.now();
  const deadline = input.deadline ?? started + DEFAULT_BUDGET_MS;
  const models = [config.GEMINI_MODEL, ...config.GEMINI_FALLBACK_MODELS.filter((m) => m !== config.GEMINI_MODEL)];

  let lastError: AiError | undefined;
  let dailyQuotaHit = false;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    const fallbacksLeft = models.length - modelIndex - 1;
    let level: "minimal" | "low" = input.thinking ?? "low";
    const buildRequest = (): RequestParts => {
      const generationConfig: Record<string, unknown> = {
        temperature: input.temperature ?? 0.8,
        maxOutputTokens: input.maxOutputTokens ?? 16000,
        responseMimeType: "application/json",
        responseJsonSchema: input.schema,
      };
      const thinking = thinkingConfig(model, level);
      if (thinking) generationConfig.thinkingConfig = thinking;
      return {
        key: config.GOOGLE_GENERATIVE_AI_API_KEY,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: "user", parts: [{ text: input.user }] }],
          generationConfig,
        }),
      };
    };
    let req = buildRequest();

    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      const slice = remaining - fallbacksLeft * RESERVE_PER_FALLBACK_MS; // what this model may spend
      if (remaining < 8_000 || (fallbacksLeft > 0 && slice < 8_000)) break;
      const timeout =
        fallbacksLeft > 0
          ? Math.min(input.perCallTimeoutMs ?? PER_CALL_TIMEOUT_MS, slice)
          : Math.min(LAST_CALL_TIMEOUT_MS, remaining);
      const outcome = await callModel(model, req, timeout, started);

      if (outcome.kind === "ok") {
        if (model !== config.GEMINI_MODEL) console.info(`[gemini] served by fallback model ${model}`);
        return outcome.result;
      }
      if (outcome.kind === "fatal") throw outcome.error;

      if (outcome.kind === "retry" && outcome.lowerThinking && level === "minimal") {
        level = "low";
        req = buildRequest();
        attempt--; // adjusting a setting is not a failed attempt
        continue;
      }

      lastError = outcome.error;
      if (outcome.kind === "skip") {
        if (outcome.dailyQuota) {
          dailyQuotaHit = true;
          console.warn(`[gemini] ${model}: daily free-tier quota exhausted, trying the next model`);
        } else {
          console.warn(`[gemini] ${model}: ${outcome.error.message} - trying the next model`);
        }
        break;
      }
      // retry: wait briefly and try the same model once more, if the time budget allows.
      if (attempt === 1 || deadline - Date.now() < outcome.waitMs + 15_000) {
        console.warn(`[gemini] ${model}: ${outcome.error.message} - trying the next model`);
        break;
      }
      await sleep(outcome.waitMs);
    }
  }

  if (dailyQuotaHit && lastError?.code === "rate_limited") {
    throw new AiError(
      "The free AI quota for today has been used up. Please try again later, or enable billing for the Google AI key to lift the limit.",
      "rate_limited",
      429,
    );
  }
  throw lastError ?? new AiError("The AI request failed.", "unavailable");
}
