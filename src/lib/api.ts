import { ZodError, type ZodType } from "zod";
import { AiError } from "@/lib/ai/gemini";
import { ConfigError } from "@/lib/env";
import { hit } from "@/lib/ratelimit";
import { TtsError } from "@/lib/tts/elevenlabs";
import type { ApiErrorBody } from "@/lib/lesson/dto";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function ok(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...init.headers } });
}

export function errorResponse(err: unknown): Response {
  let status = 500;
  let code = "internal";
  let message = "Something went wrong on our side. Please try again.";
  let retryAfterSec: number | undefined;

  if (err instanceof ApiError) {
    ({ status, code, message, retryAfterSec } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = "bad_request";
    message = err.issues[0]?.message ?? "Invalid request.";
  } else if (err instanceof AiError) {
    code = `ai_${err.code}`;
    message = err.message;
    status = { rate_limited: 429, blocked: 422, config: 503, unavailable: 503, invalid: 502 }[err.code];
    if (err.code === "config") console.error("[ai] configuration problem:", err.message);
  } else if (err instanceof TtsError) {
    code = `tts_${err.code}`;
    message = err.message;
    status = { quota: 503, config: 503, unavailable: 503, invalid: 502 }[err.code];
  } else if (err instanceof ConfigError) {
    status = 503;
    code = "not_configured";
    message = "The server is not configured correctly. Check the environment variables.";
    console.error("[config]", err.message);
  } else {
    console.error("[api] unhandled error:", err);
  }

  const body: ApiErrorBody = { error: { code, message, ...(retryAfterSec ? { retryAfterSec } : {}) } };
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...(retryAfterSec ? { "Retry-After": String(retryAfterSec) } : {}) },
  });
}

/** Run a handler and turn any thrown error into a consistent JSON error response. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "bad_request", "The request body must be valid JSON.");
  }
  return schema.parse(raw);
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim();
}

/** Per-visitor and per-IP hourly limits (the IP limit is looser so shared networks still work). */
export async function enforceLimit(
  kind: "lesson" | "message" | "audio",
  ownerId: string,
  req: Request,
  perHour: number,
): Promise<void> {
  const [byOwner, byIp] = await Promise.all([
    hit(`${kind}:u:${ownerId}`, perHour),
    hit(`${kind}:ip:${clientIp(req)}`, perHour * 4),
  ]);
  const blocked = !byOwner.ok ? byOwner : !byIp.ok ? byIp : null;
  if (blocked) {
    const mins = Math.ceil(blocked.retryAfterSec / 60);
    throw new ApiError(
      429,
      "rate_limited",
      `You're going a bit fast! Please wait about ${mins} minute${mins === 1 ? "" : "s"} and try again.`,
      blocked.retryAfterSec,
    );
  }
}
