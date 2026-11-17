import type { Page, Route } from "@playwright/test";
import type { ApiErrorBody, LessonDTO, LessonSummaryDTO, MessageDTO } from "../../../src/lib/lesson/dto";
import type { Script } from "../../../src/lib/lesson/types";
import lessonScript from "./lesson-script.json";

export const LESSON_ID = "fx1";
export const script = lessonScript as unknown as Script;

export const answerScript: Script = {
  title: "Why poles attract",
  summary: "Opposite poles attract because their field lines join up.",
  suggestions: ["What is a magnetic domain?", "Can magnets lose strength?"],
  scenes: [
    {
      title: "Field lines connect",
      clear: true,
      beats: [
        {
          say: "Opposite poles attract because the field lines leaving north curve around and enter south.",
          draw: [
            { type: "text", id: "n", text: "N", x: 400, y: 400, size: "xl", color: "red", align: "center", cue: "north" },
            { type: "text", id: "s", text: "S", x: 880, y: 400, size: "xl", color: "blue", align: "center", cue: "south" },
            { type: "arrow", id: "a", x1: 460, y1: 400, x2: 820, y2: 400, bend: 0.3, color: "ink", dashed: false, head: "end", size: "sm", cue: "curve" },
          ],
        },
      ],
    },
  ],
};

export function lessonMessage(overrides: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: "m-lesson",
    role: "assistant",
    text: script.summary,
    script,
    suggestions: script.suggestions,
    voiceMode: "browser",
    clips: [],
    createdAt: "2026-11-16T10:00:00.000Z",
    ...overrides,
  };
}

export function lessonDto(overrides: Partial<LessonDTO> = {}): LessonDTO {
  return {
    id: LESSON_ID,
    title: script.title,
    topic: "How do magnets work?",
    createdAt: "2026-11-16T10:00:00.000Z",
    isOwner: true,
    messages: [lessonMessage()],
    ...overrides,
  };
}

export const summaries: LessonSummaryDTO[] = [
  { id: LESSON_ID, title: "How Magnets Work", topic: "How do magnets work?", createdAt: new Date().toISOString() },
  { id: "fx2", title: "The Water Cycle", topic: "water cycle", createdAt: new Date(Date.now() - 3_600_000).toISOString() },
];

export interface MockOptions {
  lesson?: LessonDTO | null;
  /** Status for GET /api/lessons/:id (200 returns the lesson). */
  lessonStatus?: number;
  lessons?: LessonSummaryDTO[];
  /** Reply for POST /api/lessons (home page). */
  create?: { status: number; body: unknown; delayMs?: number };
  /** Reply for POST /api/lessons/:id/messages. */
  ask?: { status: number; body: unknown; delayMs?: number };
  askSpy?: (body: Record<string, unknown>) => void;
  onDelete?: () => void;
}

export const errorBody = (code: string, message: string): ApiErrorBody => ({ error: { code, message } });

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Replace the backend with canned responses (no database, no paid APIs). */
export async function mockApi(page: Page, opts: MockOptions = {}) {
  let lessons = opts.lessons ?? summaries;
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === "/api/lessons" && method === "GET") return json(route, 200, { lessons });
    if (path === "/api/lessons" && method === "POST") {
      const c = opts.create ?? { status: 201, body: { lessonId: LESSON_ID } };
      await wait(c.delayMs);
      return json(route, c.status, c.body);
    }
    if (path === `/api/lessons/${LESSON_ID}/messages` && method === "POST") {
      opts.askSpy?.(req.postDataJSON() as Record<string, unknown>);
      const a = opts.ask ?? { status: 201, body: {} };
      await wait(a.delayMs);
      return json(route, a.status, a.body);
    }
    if (/^\/api\/lessons\/[^/]+$/.test(path)) {
      if (method === "DELETE") {
        opts.onDelete?.();
        lessons = lessons.filter((l) => !path.endsWith(l.id));
        return json(route, 200, { deleted: true });
      }
      const status = opts.lessonStatus ?? (opts.lesson === null ? 404 : 200);
      if (status !== 200) return json(route, status, errorBody(status === 404 ? "not_found" : "internal", status === 404 ? "We couldn't find that lesson." : "Something went wrong on our side."));
      return json(route, 200, { lesson: opts.lesson ?? lessonDto() });
    }
    if (/^\/api\/messages\/[^/]+\/audio$/.test(path)) return json(route, 200, { voiceMode: "browser" });
    return route.continue();
  });
}

/** Silence the browser voice (so tests are quiet and deterministic) and reset stored preferences. */
export async function quietPrefs(page: Page, prefs: Record<string, unknown> = { captions: true, rate: 1, muted: true }) {
  await page.addInitScript((p) => {
    try {
      if (!sessionStorage.getItem("__prefs_seeded")) {
        localStorage.setItem("wbt:prefs", JSON.stringify(p));
        sessionStorage.setItem("__prefs_seeded", "1");
      }
    } catch {
      /* storage unavailable */
    }
  }, prefs);
}

export interface Snap {
  time: number;
  duration: number;
  playing: boolean;
  ended: boolean;
  scene: number;
  rate: number;
  muted: boolean;
  loaded: boolean;
}

export const engineSnap = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wbt: { engine: { getSnapshot(): unknown } } }).__wbt.engine.getSnapshot() as Snap);

export const engineSeek = (page: Page, ms: number) =>
  page.evaluate((t) => (window as unknown as { __wbt: { engine: { seek(n: number): void } } }).__wbt.engine.seek(t), ms);

export interface TimelineInfo {
  scenes: { index: number; start: number; end: number; title: string }[];
  items: { scene: number; id: string; type: string; start: number; dur: number }[];
}

export const timelineInfo = (page: Page) =>
  page.evaluate(() => {
    const tl = (window as unknown as { __wbt: { active: { timeline: { scenes: unknown[]; itemsByScene: { scene: number; action: { id: string; type: string }; start: number; dur: number }[][] } } } }).__wbt.active.timeline;
    return {
      scenes: tl.scenes as TimelineInfo["scenes"],
      items: tl.itemsByScene.flat().map((i) => ({ scene: i.scene, id: i.action.id, type: i.action.type, start: i.start, dur: i.dur })),
    } satisfies TimelineInfo;
  });

/** Open the lesson page and wait until the player is loaded. */
export async function openLesson(page: Page, id = LESSON_ID) {
  await page.goto(`/lesson/${id}`);
  await page.waitForFunction(() => (window as unknown as { __wbt?: { active?: unknown } }).__wbt?.active != null, null, { timeout: 20_000 });
}

/** Open the lesson page and wait for the player to render (works in production builds, no debug hook). */
export async function openLessonPlain(page: Page, id = LESSON_ID) {
  await page.goto(`/lesson/${id}`);
  await page.getByTestId("stage").waitFor({ timeout: 20_000 });
}
