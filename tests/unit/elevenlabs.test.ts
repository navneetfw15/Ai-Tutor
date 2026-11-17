import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEXT = "Plants make food from sunlight.";

function alignmentFor(text: string) {
  const chars = Array.from(text);
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.05),
    character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.05),
  };
}

const audio = Buffer.from("fake-mp3-bytes");
const success = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { audio_base64: audio.toString("base64"), alignment: alignmentFor(TEXT), normalized_alignment: null, ...extra },
});

interface Reply {
  status: number;
  body: unknown;
}

function mockFetch(replies: Reply[]) {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      const r = replies.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
  );
  return seen;
}

async function synth(text = TEXT) {
  const { synthesizeScene } = await import("@/lib/tts/elevenlabs");
  return synthesizeScene(text);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgres://x");
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "g");
  vi.stubEnv("ELEVENLABS_API_KEY", "sk_test_key");
  vi.stubEnv("ELEVENLABS_VOICE_ID", "voice123");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("synthesizeScene", () => {
  it("returns MP3 bytes and word timings, sending the right request", async () => {
    const seen = mockFetch([success()]);
    const out = await synth();
    expect(Buffer.compare(out.audio, audio)).toBe(0);
    expect(out.mime).toBe("audio/mpeg");
    expect(out.chars).toBe(TEXT.length);
    expect(out.timing.words.map(([a, b]) => TEXT.slice(a, b))).toEqual(["Plants", "make", "food", "from", "sunlight."]);
    expect(out.timing.durationMs).toBeGreaterThan(1500);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/v1/text-to-speech/voice123/with-timestamps");
    expect(seen[0].url).toContain("output_format=mp3_44100_64");
    expect(seen[0].headers["xi-api-key"]).toBe("sk_test_key");
    expect(seen[0].body).toMatchObject({ text: TEXT, model_id: "eleven_flash_v2_5" });
  });

  it("repairs a capitalised key prefix pasted from a chat ('Sk_' -> 'sk_')", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "Sk_abc123");
    const seen = mockFetch([success()]);
    await synth();
    expect(seen[0].headers["xi-api-key"]).toBe("sk_abc123");
  });

  it("falls back to the normalised alignment when the plain one is missing", async () => {
    mockFetch([success({ alignment: null, normalized_alignment: alignmentFor(TEXT) })]);
    expect((await synth()).timing.words).toHaveLength(5);
  });

  it("reports an exhausted quota (payment required / quota_exceeded)", async () => {
    mockFetch([{ status: 402, body: { detail: { status: "payment_required", code: "paid_plan_required" } } }]);
    await expect(synth()).rejects.toMatchObject({ code: "quota" });
    mockFetch([{ status: 401, body: { detail: { status: "quota_exceeded", message: "You have 0 credits remaining" } } }]);
    await expect(synth()).rejects.toMatchObject({ code: "quota" });
  });

  it("reports a rejected key or missing permission as a configuration problem", async () => {
    mockFetch([{ status: 401, body: { detail: { status: "missing_permissions", message: "needs text_to_speech" } } }]);
    await expect(synth()).rejects.toMatchObject({ code: "config" });
    mockFetch([{ status: 403, body: { detail: { status: "forbidden" } } }]);
    await expect(synth()).rejects.toMatchObject({ code: "config" });
  });

  it("is a configuration problem when no key is set at all", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const seen = mockFetch([]);
    await expect(synth()).rejects.toMatchObject({ code: "config" });
    expect(seen).toHaveLength(0);
  });

  it("retries rate limits and server errors with backoff, then succeeds", async () => {
    vi.useFakeTimers();
    const seen = mockFetch([{ status: 429, body: { detail: { status: "too_many_concurrent_requests" } } }, { status: 503, body: {} }, success()]);
    const pending = synth();
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await pending;
    expect(out.timing.words).toHaveLength(5);
    expect(seen).toHaveLength(3);
  });

  it("gives up as 'unavailable' after repeated failures", async () => {
    vi.useFakeTimers();
    const seen = mockFetch([{ status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }]);
    const pending = synth().catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ code: "unavailable" });
    expect(seen).toHaveLength(4);
  });

  it("does not retry requests the provider rejected as invalid", async () => {
    const seen = mockFetch([{ status: 422, body: { detail: { status: "invalid_text" } } }]);
    await expect(synth()).rejects.toMatchObject({ code: "invalid" });
    expect(seen).toHaveLength(1);
  });

  it("rejects responses without audio or without timing data", async () => {
    mockFetch([{ status: 200, body: { alignment: alignmentFor(TEXT) } }]);
    await expect(synth()).rejects.toMatchObject({ code: "invalid" });
    mockFetch([{ status: 200, body: { audio_base64: audio.toString("base64") } }]);
    await expect(synth()).rejects.toMatchObject({ code: "invalid" });
  });
});
