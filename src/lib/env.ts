import { z } from "zod";

/**
 * Server-side environment, validated lazily so `next build` works without secrets
 * and so a misconfigured deployment produces a readable error instead of a crash.
 * Only import this from server code (route handlers, server components, scripts).
 */

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1, "GOOGLE_GENERATIVE_AI_API_KEY is required"),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  /** Tried in order when the primary model is out of quota, busy or retired. */
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default("gemini-3.7-flash,gemini-3.5-flash-lite")
    .transform((s) => s.split(",").map((m) => m.trim()).filter(Boolean)),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default("EXAVITQu4vr4xnSDxMaL"),
  ELEVENLABS_MODEL: z.string().default("eleven_flash_v2_5"),
  TTS_PROVIDER: z.enum(["elevenlabs", "browser"]).optional(),
  RATE_LIMIT_LESSONS_PER_HOUR: z.coerce.number().int().positive().default(8),
  RATE_LIMIT_MESSAGES_PER_HOUR: z.coerce.number().int().positive().default(40),
  RATE_LIMIT_AUDIO_PER_HOUR: z.coerce.number().int().positive().default(120),
});

export type Env = z.infer<typeof schema> & {
  /** Effective voice provider after considering whether a key is present. */
  ttsProvider: "elevenlabs" | "browser";
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const raw = { ...process.env };
  // Treat empty strings (e.g. `FOO=` lines copied from .env.example) as unset.
  for (const key of Object.keys(raw)) if (raw[key] === "") delete raw[key];
  // ElevenLabs keys are lowercase "sk_..."; tolerate a capitalised prefix from copy/paste.
  if (raw.ELEVENLABS_API_KEY) raw.ELEVENLABS_API_KEY = raw.ELEVENLABS_API_KEY.trim().replace(/^Sk_/, "sk_");

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid server configuration (${problems}). See .env.example.`);
  }
  const data = parsed.data;
  const ttsProvider = data.TTS_PROVIDER ?? (data.ELEVENLABS_API_KEY ? "elevenlabs" : "browser");
  cached = { ...data, ttsProvider: ttsProvider === "elevenlabs" && !data.ELEVENLABS_API_KEY ? "browser" : ttsProvider };
  return cached;
}

/** Derive the direct (non-pooled) Neon URL, used for migrations. */
export function unpooledDatabaseUrl(): string {
  const e = env();
  if (e.DATABASE_URL_UNPOOLED) return e.DATABASE_URL_UNPOOLED;
  return e.DATABASE_URL.replace("-pooler", "");
}
