import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, errorResponse, handle, ok, parseBody } from "@/lib/api";
import { AiError } from "@/lib/ai/gemini";
import { ConfigError } from "@/lib/env";
import { TtsError } from "@/lib/tts/elevenlabs";

const body = async (res: Response) => (await res.json()) as { error: { code: string; message: string; retryAfterSec?: number } };

describe("errorResponse", () => {
  it("maps ApiError to its status and exposes the retry hint", async () => {
    const res = errorResponse(new ApiError(429, "rate_limited", "Slow down", 120));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await body(res)).toEqual({ error: { code: "rate_limited", message: "Slow down", retryAfterSec: 120 } });
  });

  it("maps validation errors to 400 with a readable message", async () => {
    const parsed = z.object({ topic: z.string().min(3, "Tell me more.") }).safeParse({ topic: "a" });
    expect(parsed.success).toBe(false);
    const res = errorResponse(parsed.error);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatchObject({ code: "bad_request", message: "Tell me more." });
  });

  it("maps AI errors to the right HTTP status and keeps the friendly message", async () => {
    const cases: [ConstructorParameters<typeof AiError>[1], number][] = [
      ["rate_limited", 429],
      ["blocked", 422],
      ["config", 503],
      ["unavailable", 503],
      ["invalid", 502],
    ];
    for (const [code, status] of cases) {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = errorResponse(new AiError(`msg ${code}`, code));
      expect(res.status).toBe(status);
      expect(await body(res)).toEqual({ error: { code: `ai_${code}`, message: `msg ${code}` } });
    }
  });

  it("maps voice errors", async () => {
    expect(errorResponse(new TtsError("quota", "quota")).status).toBe(503);
    expect((await body(errorResponse(new TtsError("bad", "invalid")))).error.code).toBe("tts_invalid");
  });

  it("hides configuration details from visitors but logs them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = errorResponse(new ConfigError("Invalid server configuration (DATABASE_URL: required)"));
    expect(res.status).toBe(503);
    const text = JSON.stringify(await body(res));
    expect(text).not.toContain("DATABASE_URL");
    expect(log).toHaveBeenCalled();
  });

  it("never leaks the message of unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = errorResponse(new Error("connect ECONNREFUSED postgres://user:secret@host/db"));
    expect(res.status).toBe(500);
    const parsed = await body(res);
    expect(JSON.stringify(parsed)).not.toMatch(/secret|postgres|ECONNREFUSED/);
    expect(parsed.error.code).toBe("internal");
  });
});

describe("handle / ok / parseBody", () => {
  it("handle turns thrown errors into responses and passes successes through", async () => {
    expect((await handle(async () => ok({ fine: true }))).status).toBe(200);
    const failing = await handle(async () => {
      throw new ApiError(404, "not_found", "gone");
    });
    expect(failing.status).toBe(404);
  });

  it("parseBody validates JSON bodies", async () => {
    const schema = z.object({ n: z.number() });
    const good = new Request("http://x", { method: "POST", body: JSON.stringify({ n: 3 }) });
    expect(await parseBody(good, schema)).toEqual({ n: 3 });
    const notJson = new Request("http://x", { method: "POST", body: "{oops" });
    await expect(parseBody(notJson, schema)).rejects.toMatchObject({ status: 400, code: "bad_request" });
    const wrong = new Request("http://x", { method: "POST", body: JSON.stringify({ n: "x" }) });
    await expect(parseBody(wrong, schema)).rejects.toBeInstanceOf(z.ZodError);
  });
});
