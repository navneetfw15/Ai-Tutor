import { randomBytes, randomUUID } from "node:crypto";
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { eq, like } from "drizzle-orm";
import { db } from "../../src/lib/db/client";
import { clips, lessons, messages, rateLimits } from "../../src/lib/db/schema";
import { hit } from "../../src/lib/ratelimit";
import { answerScript } from "./fixtures";

/**
 * HTTP contract tests against the real database (seeded directly) - no Gemini or ElevenLabs calls.
 */

const OWNER = randomUUID();
const STRANGER = randomUUID();
const tag = randomBytes(4).toString("hex");
const LESSON = `apitest${tag}`;
const MESSAGE = `${LESSON}m1`;
const BROWSER_MESSAGE = `${LESSON}m2`;
const CLIP = `${LESSON}c0`;
const audio = randomBytes(1000);

let owner: APIRequestContext;
let stranger: APIRequestContext;
let anonymous: APIRequestContext;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ playwright }) => {
  const baseURL = test.info().project.use.baseURL ?? "http://localhost:3000";
  const as = (uid?: string) =>
    pwRequest.newContext({ baseURL, extraHTTPHeaders: uid ? { cookie: `tutor_uid=${uid}` } : {} });
  [owner, stranger, anonymous] = await Promise.all([as(OWNER), as(STRANGER), as()]);
  void playwright;

  const d = db();
  await d.insert(lessons).values({ id: LESSON, ownerId: OWNER, topic: "api test topic", title: "API test lesson" });
  await d.insert(messages).values([
    {
      id: MESSAGE,
      lessonId: LESSON,
      seq: 1,
      role: "assistant",
      text: "Seeded lesson",
      script: answerScript,
      suggestions: ["next?"],
      voiceMode: "eleven",
    },
    {
      id: BROWSER_MESSAGE,
      lessonId: LESSON,
      seq: 2,
      role: "assistant",
      text: "Browser voiced",
      script: answerScript,
      voiceMode: "browser",
    },
  ]);
  await d.insert(clips).values({
    id: CLIP,
    messageId: MESSAGE,
    sceneIndex: 0,
    audio,
    bytes: audio.length,
    durationMs: 4200,
    words: [[0, 8, 100, 600]],
  });
});

test.afterAll(async () => {
  await db().delete(lessons).where(eq(lessons.id, LESSON)); // cascades to messages and clips
  await db().delete(rateLimits).where(like(rateLimits.key, `test%:${tag}`));
  await Promise.all([owner?.dispose(), stranger?.dispose(), anonymous?.dispose()]);
});

test.describe("health", () => {
  test("reports configuration and database connectivity without leaking secrets", async () => {
    const res = await anonymous.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, database: "connected" });
    expect(JSON.stringify(body)).not.toMatch(/sk_|AQ\.|npg_|postgres/i);
  });
});

test.describe("reading lessons", () => {
  test("anyone with the link can read a lesson; only the owner is flagged as owner", async () => {
    const asStranger = await (await stranger.get(`/api/lessons/${LESSON}`)).json();
    expect(asStranger.lesson).toMatchObject({ id: LESSON, title: "API test lesson", isOwner: false });
    const asOwner = await (await owner.get(`/api/lessons/${LESSON}`)).json();
    expect(asOwner.lesson.isOwner).toBe(true);
    expect(asOwner.lesson.messages).toHaveLength(2);
  });

  test("clips are listed as metadata with a URL - the audio bytes are never inlined", async () => {
    const res = await owner.get(`/api/lessons/${LESSON}`);
    const text = await res.text();
    const msg = JSON.parse(text).lesson.messages[0];
    expect(msg.clips).toEqual([{ sceneIndex: 0, url: `/api/clips/${CLIP}`, durationMs: 4200, words: [[0, 8, 100, 600]] }]);
    expect(text.length).toBeLessThan(20_000);
    expect(msg.voiceMode).toBe("eleven");
  });

  test("unknown or malformed ids are 404, not errors", async () => {
    expect((await anonymous.get("/api/lessons/doesnotexist1")).status()).toBe(404);
    expect((await anonymous.get("/api/lessons/..%2F..%2Fetc")).status()).toBe(404);
    expect((await anonymous.get("/api/lessons/a")).status()).toBe(404);
    const body = await (await anonymous.get("/api/lessons/doesnotexist1")).json();
    expect(body.error).toMatchObject({ code: "not_found" });
  });

  test("a visitor sees only their own lessons in the list", async () => {
    const mine = await (await owner.get("/api/lessons")).json();
    expect(mine.lessons.map((l: { id: string }) => l.id)).toContain(LESSON);
    const theirs = await (await stranger.get("/api/lessons")).json();
    expect(theirs.lessons.map((l: { id: string }) => l.id)).not.toContain(LESSON);
    expect((await (await anonymous.get("/api/lessons")).json()).lessons).toEqual([]);
  });
});

test.describe("audio clips", () => {
  const url = `/api/clips/${CLIP}`;

  test("serves the full clip with cache headers", async () => {
    const res = await anonymous.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("audio/mpeg");
    expect(res.headers()["accept-ranges"]).toBe("bytes");
    expect(res.headers()["cache-control"]).toContain("immutable");
    expect(Buffer.compare(await res.body(), audio)).toBe(0);
  });

  test("supports byte ranges so the player can seek", async () => {
    const part = await anonymous.get(url, { headers: { range: "bytes=100-199" } });
    expect(part.status()).toBe(206);
    expect(part.headers()["content-range"]).toBe("bytes 100-199/1000");
    expect(Buffer.compare(await part.body(), audio.subarray(100, 200))).toBe(0);

    const tail = await anonymous.get(url, { headers: { range: "bytes=990-" } });
    expect(tail.status()).toBe(206);
    expect(Buffer.compare(await tail.body(), audio.subarray(990))).toBe(0);

    const suffix = await anonymous.get(url, { headers: { range: "bytes=-10" } });
    expect(suffix.headers()["content-range"]).toBe("bytes 990-999/1000");

    const clamped = await anonymous.get(url, { headers: { range: "bytes=900-5000" } });
    expect(clamped.headers()["content-range"]).toBe("bytes 900-999/1000");
  });

  test("rejects unsatisfiable ranges and unknown clips", async () => {
    const bad = await anonymous.get(url, { headers: { range: "bytes=5000-" } });
    expect(bad.status()).toBe(416);
    expect(bad.headers()["content-range"]).toBe("bytes */1000");
    expect((await anonymous.get("/api/clips/nope12345")).status()).toBe(404);
    expect((await anonymous.get("/api/clips/..%2Fx")).status()).toBe(404);
  });
});

test.describe("narration endpoint", () => {
  const post = (ctx: APIRequestContext, id: string, data: unknown) => ctx.post(`/api/messages/${id}/audio`, { data });

  test("only the owner may generate narration", async () => {
    expect((await post(stranger, MESSAGE, { scene: 0 })).status()).toBe(403);
    expect((await post(anonymous, MESSAGE, { scene: 0 })).status()).toBe(403);
  });

  test("returns an existing clip without calling the voice provider", async () => {
    const res = await post(owner, MESSAGE, { scene: 0 });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({
      voiceMode: "eleven",
      clip: { sceneIndex: 0, url: `/api/clips/${CLIP}`, durationMs: 4200, words: [[0, 8, 100, 600]] },
    });
  });

  test("browser-voiced messages never hit the provider", async () => {
    const res = await post(owner, BROWSER_MESSAGE, { scene: 0 });
    expect(await res.json()).toEqual({ voiceMode: "browser" });
  });

  test("validates the request", async () => {
    expect((await post(owner, MESSAGE, { scene: 99 })).status()).toBe(400);
    expect((await post(owner, MESSAGE, { scene: "x" })).status()).toBe(400);
    expect((await post(owner, MESSAGE, { scene: 5 })).status()).toBe(404); // valid number, no such scene
    expect((await post(owner, "unknownmsg1", { scene: 0 })).status()).toBe(404);
    const notJson = await owner.post(`/api/messages/${MESSAGE}/audio`, { headers: { "content-type": "application/json" }, data: "not json" });
    expect(notJson.status()).toBe(400);
  });
});

test.describe("creating lessons and asking questions: validation and access", () => {
  const create = (data: unknown) => anonymous.post("/api/lessons", { data });

  test("rejects unusable topics before any AI call", async () => {
    for (const data of [{ topic: "a" }, { topic: "   " }, { topic: "!!! ???" }, { topic: "x".repeat(201) }, {}, { topic: 42 }]) {
      const res = await create(data);
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
    const bad = await anonymous.post("/api/lessons", { headers: { "content-type": "application/json" }, data: "{oops" });
    expect(bad.status()).toBe(400);
  });

  test("follow-up questions are for the lesson's owner only, and validated", async () => {
    const ask = (ctx: APIRequestContext, data: unknown) => ctx.post(`/api/lessons/${LESSON}/messages`, { data });
    expect((await ask(stranger, { text: "Why is the sky blue?" })).status()).toBe(403);
    expect((await ask(anonymous, { text: "Why is the sky blue?" })).status()).toBe(403);
    expect((await ask(owner, { text: "" })).status()).toBe(400);
    expect((await ask(owner, { text: "y".repeat(501) })).status()).toBe(400);
    expect((await ask(owner, { text: "ok question", sceneIndex: -1 })).status()).toBe(400);
    const missing = await owner.post("/api/lessons/nolesson123/messages", { data: { text: "hello there" } });
    expect(missing.status()).toBe(404);
  });
});

test.describe("rate limiting", () => {
  test("allows up to the limit, then blocks with a retry hint", async () => {
    const key = `test:${tag}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await hit(key, 3, 3600));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    expect(results[4].count).toBe(5);
    expect(results[4].retryAfterSec).toBeGreaterThan(3000);
    expect(results[4].retryAfterSec).toBeLessThanOrEqual(3600);
  });

  test("a new window starts after the old one expires", async () => {
    const key = `test-win:${tag}`;
    await hit(key, 1, 1);
    expect((await hit(key, 1, 1)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 1300));
    expect((await hit(key, 1, 1)).ok).toBe(true);
  });
});

test.describe("deleting", () => {
  test("only the owner can delete, and deleting removes messages and audio", async () => {
    expect((await stranger.delete(`/api/lessons/${LESSON}`)).status()).toBe(404);
    expect((await anonymous.delete(`/api/lessons/${LESSON}`)).status()).toBe(404);
    expect((await anonymous.get(`/api/lessons/${LESSON}`)).status()).toBe(200); // still there

    const res = await owner.delete(`/api/lessons/${LESSON}`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect((await anonymous.get(`/api/lessons/${LESSON}`)).status()).toBe(404);
    expect((await anonymous.get(`/api/clips/${CLIP}`)).status()).toBe(404); // cascade
    expect((await owner.delete(`/api/lessons/${LESSON}`)).status()).toBe(404); // already gone
  });
});
