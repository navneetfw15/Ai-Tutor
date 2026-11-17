import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A canned HTTP reply: SSE text/pieces for 200s, a JSON body for errors. */
interface Reply {
  status: number;
  body?: unknown;
  /** Raw SSE payload for a 200 response. */
  sse?: string;
  /** Deliver the SSE payload in these pieces (to test chunk boundaries). */
  pieces?: string[];
  /** Build the response body stream yourself. */
  stream?: () => ReadableStream<Uint8Array>;
}

const enc = new TextEncoder();
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
const chunk = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, ...extra }],
});

const ok = (text: string): Reply => ({
  status: 200,
  sse: sse({ ...chunk(text, { finishReason: "STOP" }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
});
const dailyQuota: Reply = {
  status: 429,
  body: { error: { message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { "@type": "RetryInfo", retryDelay: "66490s" }] } },
};
const minuteLimit = (secs: number): Reply => ({
  status: 429,
  body: { error: { message: "slow down", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { "@type": "RetryInfo", retryDelay: `${secs}s` }] } },
});
const busy: Reply = { status: 503, body: { error: { message: "high demand" } } };
const gone: Reply = { status: 404, body: { error: { message: "model no longer available" } } };

function toResponse(r: Reply): Response {
  if (r.stream) return new Response(r.stream(), { status: 200 });
  if (r.pieces) {
    return new Response(
      new ReadableStream({
        start(c) {
          for (const p of r.pieces!) c.enqueue(enc.encode(p));
          c.close();
        },
      }),
      { status: 200 },
    );
  }
  if (r.sse !== undefined) return new Response(r.sse, { status: r.status });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
}

/** Replies are consumed in order; the model name and body of each call are recorded. */
function mockFetch(replies: Reply[], bodies: string[] = []) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push(/models\/([^:]+):/.exec(String(url))![1]);
    bodies.push(String(init?.body ?? ""));
    return toResponse(replies.shift() ?? busy);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

async function run(thinking?: "minimal" | "low") {
  const { generateJson } = await import("@/lib/ai/gemini");
  return generateJson({ system: "s", user: "u", schema: {}, thinking });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgres://x");
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key");
  vi.stubEnv("GEMINI_MODEL", "model-a");
  vi.stubEnv("GEMINI_FALLBACK_MODELS", "model-b, model-c");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("generateJson", () => {
  it("returns the primary model's answer and parses JSON (even inside code fences)", async () => {
    const calls = mockFetch([ok('```json\n{"a":1}\n```')]);
    const res = await run();
    expect(res.json).toEqual({ a: 1 });
    expect(res.model).toBe("model-a");
    expect(res.usage).toMatchObject({ promptTokens: 10, outputTokens: 5 });
    expect(calls).toEqual(["model-a"]);
  });

  it("uses the streaming endpoint and sends the key as a header, never in the URL", async () => {
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        headers.push(init.headers as Record<string, string>);
        return toResponse(ok('{"z":1}'));
      }),
    );
    await run();
    expect(urls[0]).toContain(":streamGenerateContent?alt=sse");
    expect(urls[0]).not.toContain("test-key");
    expect(headers[0]["x-goog-api-key"]).toBe("test-key");
  });

  it("reassembles text from many events, split at arbitrary byte boundaries", async () => {
    const full =
      sse(chunk('{"hello":"wor'), chunk('ld","n":'), { ...chunk("42}", { finishReason: "STOP" }), usageMetadata: { candidatesTokenCount: 9 } }) + "";
    const cut = [full.slice(0, 17), full.slice(17, 60), full.slice(60, 61), full.slice(61)];
    const calls = mockFetch([{ status: 200, pieces: cut }]);
    const res = await run();
    expect(res.json).toEqual({ hello: "world", n: 42 });
    expect(res.usage?.outputTokens).toBe(9);
    expect(calls).toEqual(["model-a"]);
  });

  it("ignores thought parts", async () => {
    const calls = mockFetch([
      { status: 200, sse: sse({ candidates: [{ content: { parts: [{ text: "thinking out loud", thought: true }, { text: '{"v":1}' }] }, finishReason: "STOP" }] }) },
    ]);
    expect((await run()).json).toEqual({ v: 1 });
    expect(calls).toEqual(["model-a"]);
  });

  it("moves to the next model when the daily free quota is exhausted (no waiting)", async () => {
    const calls = mockFetch([dailyQuota, ok('{"b":2}')]);
    const started = Date.now();
    const res = await run();
    expect(res.model).toBe("model-b");
    expect(calls).toEqual(["model-a", "model-b"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("retries a short per-minute limit on the same model after the hinted delay", async () => {
    const calls = mockFetch([minuteLimit(0.1), ok('{"c":3}')]);
    const res = await run();
    expect(res.model).toBe("model-a");
    expect(calls).toEqual(["model-a", "model-a"]);
  });

  it("falls back after repeated 503s on one model", async () => {
    const calls = mockFetch([busy, busy, ok('{"d":4}')]);
    const res = await run();
    expect(res.model).toBe("model-b");
    expect(calls).toEqual(["model-a", "model-a", "model-b"]);
  });

  it("skips a retired model (404) straight away", async () => {
    const calls = mockFetch([gone, ok('{"e":5}')]);
    const res = await run();
    expect(res.model).toBe("model-b");
    expect(calls).toEqual(["model-a", "model-b"]);
  });

  it("retries the same model at a lower thinking level when 'minimal' is not supported", async () => {
    const unsupported: Reply = { status: 400, body: { error: { message: "Thinking level MINIMAL is not supported for this model." } } };
    vi.stubEnv("GEMINI_MODEL", "gemini-3-test"); // thinking levels are only sent to gemini-3.x models
    const bodies: string[] = [];
    const calls = mockFetch([unsupported, ok('{"g":7}')], bodies);
    const res = await run("minimal");
    expect(res.model).toBe("gemini-3-test");
    expect(calls).toEqual(["gemini-3-test", "gemini-3-test"]);
    expect(JSON.parse(bodies[0]).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(JSON.parse(bodies[1]).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("moves on when a model returns malformed JSON", async () => {
    const calls = mockFetch([ok("{not json"), ok('{"f":6}')]);
    const res = await run();
    expect(res.model).toBe("model-b");
    expect(calls).toEqual(["model-a", "model-b"]);
  });

  it("explains when every model's daily quota is used up", async () => {
    const calls = mockFetch([dailyQuota, dailyQuota, dailyQuota]);
    await expect(run()).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/quota for today/i) });
    expect(calls).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("does not try other models when the API key is rejected", async () => {
    const calls = mockFetch([{ status: 403, body: { error: { message: "forbidden" } } }]);
    await expect(run()).rejects.toMatchObject({ code: "config" });
    expect(calls).toEqual(["model-a"]);
  });

  it("reports blocked content without falling back", async () => {
    const calls = mockFetch([{ status: 200, sse: sse({ promptFeedback: { blockReason: "SAFETY" } }) }]);
    await expect(run()).rejects.toMatchObject({ code: "blocked" });
    expect(calls).toEqual(["model-a"]);
  });

  it("gives up with the last error when nothing works", async () => {
    mockFetch([busy, busy, busy, busy, busy, busy]);
    await expect(run()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("retries once when the connection drops mid-stream", async () => {
    const dropping: Reply = {
      status: 200,
      stream: () =>
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(sse(chunk('{"par'))));
            c.error(new Error("connection reset"));
          },
        }),
    };
    const calls = mockFetch([dropping, ok('{"i":9}')]);
    const res = await run();
    expect(res.json).toEqual({ i: 9 });
    expect(calls).toEqual(["model-a", "model-a"]);
  });
});

describe("hung and slow models", () => {
  const hang = (signalHook: { aborted: boolean }) => (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        signalHook.aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  it("abandons a model that sends nothing for 25s and uses the next one", async () => {
    vi.useFakeTimers();
    const hook = { aborted: false };
    let call = 0;
    const models: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        models.push(/models\/([^:]+):/.exec(url)![1]);
        return call++ === 0 ? hang(hook)(url, init) : Promise.resolve(toResponse(ok('{"h":8}')));
      }),
    );
    const pending = run();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(hook.aborted).toBe(false); // still within the grace period
    await vi.advanceTimersByTimeAsync(1_500);
    const res = await pending;
    expect(hook.aborted).toBe(true);
    expect(res.model).toBe("model-b");
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("lets a slow model finish once it has started streaming (silence is the only trigger)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        toResponse({
          status: 200,
          stream: () =>
            new ReadableStream({
              async start(c) {
                c.enqueue(enc.encode(sse(chunk('{"slow":'))));
                await new Promise((r) => setTimeout(r, 35_000)); // longer than the 25s silence limit
                c.enqueue(enc.encode(sse(chunk("true}", { finishReason: "STOP" }))));
                c.close();
              },
            }),
        }),
      ),
    );
    const pending = run();
    await vi.advanceTimersByTimeAsync(36_000);
    const res = await pending;
    expect(res.model).toBe("model-a");
    expect(res.json).toEqual({ slow: true });
  });

  it("a model that streams forever is cut off at its time slice, leaving time for fallbacks", async () => {
    vi.useFakeTimers();
    let call = 0;
    const models: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        models.push(/models\/([^:]+):/.exec(url)![1]);
        if (call++ > 0) return toResponse(ok('{"ok":1}'));
        return toResponse({
          status: 200,
          stream: () =>
            new ReadableStream({
              start(c) {
                const tick = setInterval(() => c.enqueue(enc.encode(sse(chunk(" ")))), 2000); // alive but never finishing
                init.signal!.addEventListener("abort", () => {
                  clearInterval(tick);
                  c.error(new DOMException("aborted", "AbortError"));
                });
              },
            }),
        });
      }),
    );
    const pending = run();
    await vi.advanceTimersByTimeAsync(51_000); // the default per-call limit is 50s
    const res = await pending;
    expect(res.model).toBe("model-b");
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("answers can use a shorter per-call limit", async () => {
    vi.useFakeTimers();
    let call = 0;
    const hook = { aborted: false };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => (call++ === 0 ? hang(hook)(url, init) : Promise.resolve(toResponse(ok('{"k":1}'))))),
    );
    const { generateJson } = await import("@/lib/ai/gemini");
    const pending = generateJson({ system: "s", user: "u", schema: {}, perCallTimeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_500); // aborts at the 10s overall limit (before the 25s silence limit)
    const res = await pending;
    expect(res.model).toBe("model-b");
  });
});
