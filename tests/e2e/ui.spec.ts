import { expect, test, type Page } from "@playwright/test";
import {
  LESSON_ID,
  answerScript,
  engineSeek,
  engineSnap,
  errorBody,
  lessonDto,
  lessonMessage,
  mockApi,
  openLesson,
  quietPrefs,
  script,
  summaries,
  timelineInfo,
} from "./fixtures";

/**
 * UI behaviour against a mocked backend: no database, no Gemini, no ElevenLabs, no credits.
 * Runs on desktop, tablet and phone viewports (see playwright.config.ts).
 */

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 640;
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

test.describe("home", () => {
  test.beforeEach(async ({ page }) => {
    await quietPrefs(page);
  });

  test("shows the hero, the topic box and example topics", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /learn anything in two minutes/i })).toBeVisible();
    await expect(page.getByTestId("topic-input")).toBeFocused();
    await expect(page.getByRole("button", { name: "How do black holes form?" })).toBeVisible();
    await expect(page.getByTestId("recent-lesson")).toHaveCount(2);
  });

  test("the start button needs a real topic; Enter submits and opens the lesson", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    const start = page.getByTestId("start-lesson");
    await expect(start).toBeDisabled();
    await page.getByTestId("topic-input").fill("ab");
    await expect(start).toBeDisabled();
    await page.getByTestId("topic-input").fill("How do magnets work?");
    await expect(start).toBeEnabled();
    const request = page.waitForRequest((r) => r.url().endsWith("/api/lessons") && r.method() === "POST");
    await page.getByTestId("topic-input").press("Enter");
    expect((await request).postDataJSON()).toEqual({ topic: "How do magnets work?" });
    await expect(page).toHaveURL(new RegExp(`/lesson/${LESSON_ID}$`));
    await expect(page.getByTestId("stage")).toBeVisible();
  });

  test("an example topic starts that lesson straight away", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    const request = page.waitForRequest((r) => r.url().endsWith("/api/lessons") && r.method() === "POST");
    await page.getByRole("button", { name: "Explain recursion in programming" }).click();
    expect((await request).postDataJSON()).toEqual({ topic: "Explain recursion in programming" });
    await expect(page).toHaveURL(new RegExp(`/lesson/${LESSON_ID}$`));
  });

  test("shows progress while the lesson is being written and can be cancelled", async ({ page }) => {
    await mockApi(page, { create: { status: 201, body: { lessonId: LESSON_ID }, delayMs: 4000 } });
    await page.goto("/");
    await page.getByTestId("topic-input").fill("How do magnets work?");
    await page.getByTestId("start-lesson").click();
    await expect(page.getByTestId("generating")).toBeVisible();
    await expect(page.getByTestId("generating-status")).toContainText("Planning the lesson");
    await page.getByTestId("cancel-generation").click();
    await expect(page.getByTestId("topic-input")).toBeVisible();
    await page.waitForTimeout(4500); // the late response must not navigate away after cancelling
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("topic-input")).toHaveValue("How do magnets work?");
  });

  test("shows a friendly error and keeps what was typed", async ({ page }) => {
    await mockApi(page, { create: { status: 429, body: errorBody("rate_limited", "You're going a bit fast! Please wait about 5 minutes and try again.") } });
    await page.goto("/");
    await page.getByTestId("topic-input").fill("How do magnets work?");
    await page.getByTestId("start-lesson").click();
    await expect(page.getByTestId("home-error")).toContainText("going a bit fast");
    await expect(page.getByTestId("topic-input")).toHaveValue("How do magnets work?");
    await expect(page.getByTestId("generating")).toHaveCount(0);
  });

  test("shows the tutor's polite refusal for unsafe topics", async ({ page }) => {
    await mockApi(page, { create: { status: 200, body: { refusal: "I can't help with that, but I'd love to teach you something else!" } } });
    await page.goto("/");
    await page.getByTestId("topic-input").fill("something unsafe");
    await page.getByTestId("start-lesson").click();
    await expect(page.getByTestId("home-refusal")).toContainText("something else");
    await expect(page).toHaveURL(/\/$/);
  });

  test("shows network failures clearly", async ({ page }) => {
    await mockApi(page);
    await page.route("**/api/lessons", (route) => (route.request().method() === "POST" ? route.abort("failed") : route.fallback()));
    await page.goto("/");
    await page.getByTestId("topic-input").fill("How do magnets work?");
    await page.getByTestId("start-lesson").click();
    await expect(page.getByTestId("home-error")).toContainText(/can't reach the server/i);
  });

  test("recent lessons open their lesson", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.getByTestId("recent-lesson").nth(1).click();
    await expect(page).toHaveURL(/\/lesson\/fx2$/);
  });

  test("has no horizontal scrolling", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("lesson player", () => {
  test.beforeEach(async ({ page }) => {
    await quietPrefs(page);
    await mockApi(page);
    await openLesson(page);
  });

  test("loads the lesson: start overlay, chapters, duration", async ({ page }) => {
    await expect(page.getByTestId("start-overlay")).toBeVisible();
    await expect(page.getByTestId("lesson-card")).toContainText("How Magnets Work");
    await expect(page.locator('[data-testid^="card-chapter-"]')).toHaveCount(script.scenes.length);
    const s = await engineSnap(page);
    expect(s).toMatchObject({ loaded: true, playing: false, time: 0 });
    expect(s.duration).toBeGreaterThan(60_000);
    await expect(page.getByTestId("time-label")).toContainText("0:00");
  });

  test("play: time advances, the board draws and captions show the spoken words", async ({ page }) => {
    await page.getByTestId("start-overlay").click();
    await expect(page.getByTestId("start-overlay")).toHaveCount(0);
    await expect.poll(async () => (await engineSnap(page)).time, { timeout: 8000 }).toBeGreaterThan(1500);
    expect((await engineSnap(page)).playing).toBe(true);
    await expect.poll(() => page.locator('[data-testid="board-items"] [data-id]').count()).toBeGreaterThan(0);
    await expect(page.getByTestId("captions")).not.toContainText("Captions appear here");
    await expect(page.getByTestId("play-pause")).toHaveAttribute("aria-label", "Pause");
  });

  test("pause holds the position and play resumes from it", async ({ page }) => {
    await page.getByTestId("start-overlay").click();
    await expect.poll(async () => (await engineSnap(page)).time).toBeGreaterThan(800);
    await page.getByTestId("play-pause").click();
    const held = (await engineSnap(page)).time;
    await expect(page.getByTestId("play-pause")).toHaveAttribute("aria-label", "Play");
    await page.waitForTimeout(1200);
    expect((await engineSnap(page)).time).toBe(held);
    await page.getByTestId("play-pause").click();
    await expect.poll(async () => (await engineSnap(page)).time).toBeGreaterThan(held + 600);
  });

  test("the scrubber seeks anywhere, and the board shows that moment", async ({ page }) => {
    const { duration } = await engineSnap(page);
    const target = Math.round(duration * 0.5);
    await page.getByTestId("scrubber").evaluate((el, v) => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, target);
    await expect.poll(async () => Math.abs((await engineSnap(page)).time - target)).toBeLessThan(60);
    await expect(page.getByTestId("time-label")).toContainText(`${Math.floor(target / 60000)}:`);
    await expect.poll(() => page.locator('[data-testid="board-items"] [data-id]').count()).toBeGreaterThan(0);
    await expect(page.getByTestId("start-overlay")).toHaveCount(0); // not the first moment any more
  });

  test("back/forward 5 seconds and restart", async ({ page }) => {
    await engineSeek(page, 20_000);
    await page.getByRole("button", { name: "Forward 5 seconds" }).click();
    expect((await engineSnap(page)).time).toBe(25_000);
    await page.getByRole("button", { name: "Back 5 seconds" }).click();
    await page.getByRole("button", { name: "Back 5 seconds" }).click();
    expect((await engineSnap(page)).time).toBe(15_000);
    await engineSeek(page, 2000);
    await page.getByRole("button", { name: "Back 5 seconds" }).click();
    expect((await engineSnap(page)).time).toBe(0); // clamped
    // Restart is part of the player on every screen size, phones included.
    await engineSeek(page, 40_000);
    await page.getByRole("button", { name: "Restart" }).click();
    expect((await engineSnap(page)).time).toBe(0);
  });

  test("playback speed", async ({ page }) => {
    await page.getByTestId("speed").selectOption("1.5");
    expect((await engineSnap(page)).rate).toBe(1.5);
    await page.getByTestId("start-overlay").click();
    await expect.poll(async () => (await engineSnap(page)).time, { timeout: 8000 }).toBeGreaterThan(2000);
    // At 1.5x the clock runs faster than the wall clock.
    const t0 = (await engineSnap(page)).time;
    await page.waitForTimeout(2000);
    const delta = (await engineSnap(page)).time - t0;
    expect(delta).toBeGreaterThan(2400);
    await page.getByTestId("speed").selectOption("1");
    expect((await engineSnap(page)).rate).toBe(1);
  });

  test("captions can be switched off and the choice is remembered", async ({ page }) => {
    await page.getByTestId("start-overlay").click();
    await expect(page.getByTestId("captions")).toBeVisible();
    await page.getByRole("button", { name: "Hide captions" }).click();
    await expect(page.getByTestId("captions")).toHaveCount(0);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __wbt?: { active?: unknown } }).__wbt?.active != null);
    await expect(page.getByTestId("captions")).toHaveCount(0);
    await page.getByRole("button", { name: "Show captions" }).click();
    await expect(page.getByTestId("captions")).toBeVisible();
  });

  test("mute toggle", async ({ page }) => {
    test.skip(isPhone(page), "the mute button is hidden on phones (the device volume is used)");
    // quietPrefs starts muted
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
    await page.getByRole("button", { name: "Unmute" }).click();
    expect((await engineSnap(page)).muted).toBe(false);
    await page.getByRole("button", { name: "Mute" }).click();
    expect((await engineSnap(page)).muted).toBe(true);
  });

  test("keyboard shortcuts: space, arrows, c", async ({ page }) => {
    test.skip(isPhone(page), "no hardware keyboard on phones");
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Space");
    await expect.poll(async () => (await engineSnap(page)).playing).toBe(true);
    await page.keyboard.press("Space");
    await expect.poll(async () => (await engineSnap(page)).playing).toBe(false);
    const t = (await engineSnap(page)).time;
    await page.keyboard.press("ArrowRight");
    expect((await engineSnap(page)).time).toBeCloseTo(t + 5000, 0); // times are floats once audio/clock-driven
    await page.keyboard.press("ArrowLeft");
    expect((await engineSnap(page)).time).toBeCloseTo(t, 0);
    await page.keyboard.press("c");
    await expect(page.getByTestId("captions")).toHaveCount(0);
    await page.keyboard.press("c");
    await expect(page.getByTestId("captions")).toBeVisible();
  });

  test("typing in the question box does not trigger shortcuts", async ({ page }) => {
    const box = page.getByTestId("composer-input");
    await box.click();
    await box.pressSequentially("c m f ");
    await expect(box).toHaveValue("c m f ");
    expect((await engineSnap(page)).playing).toBe(false);
    await expect(page.getByTestId("captions")).toBeVisible();
  });

  test("plays to the end, then offers a replay", async ({ page }) => {
    const { duration } = await engineSnap(page);
    await engineSeek(page, duration - 600);
    await page.getByTestId("play-pause").click();
    await expect(page.getByTestId("replay")).toBeVisible({ timeout: 10_000 });
    const s = await engineSnap(page);
    expect(s).toMatchObject({ ended: true, playing: false });
    await page.getByTestId("replay").click();
    await expect.poll(async () => (await engineSnap(page)).playing).toBe(true);
    expect((await engineSnap(page)).time).toBeLessThan(3000);
  });

  test("lesson card chapters jump to that part and play", async ({ page }) => {
    const tl = await timelineInfo(page);
    await page.getByTestId("card-chapter-2").click();
    await expect.poll(async () => (await engineSnap(page)).scene).toBe(2);
    expect((await engineSnap(page)).time).toBeGreaterThanOrEqual(tl.scenes[2].start);
    await expect.poll(async () => (await engineSnap(page)).playing).toBe(true);
  });

  test("the chapter strip appears on tall desktop screens", async ({ page }) => {
    test.skip(!isDesktop(page), "chapter strip is a desktop feature");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const strip = page.getByRole("navigation", { name: "Chapters" });
    await expect(strip).toBeVisible();
    await page.getByTestId("chapter-3").click();
    await expect.poll(async () => (await engineSnap(page)).scene).toBe(3);
    await expect(page.getByTestId("chapter-3")).toHaveAttribute("aria-current", "step");
  });

  test("seeking is exact: elements appear only once their moment has come", async ({ page }) => {
    const tl = await timelineInfo(page);
    // Items well inside their scene (past the scene-change fade), one sample per scene.
    const samples = tl.scenes
      .map((s) => tl.items.find((i) => i.scene === s.index && i.type !== "pointer" && i.type !== "erase" && i.start > s.start + 600 && i.start + i.dur < s.end - 200))
      .filter((i): i is NonNullable<typeof i> => !!i);
    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const item of samples) {
      const selector = `[data-testid="board-items"] [data-id="${item.id}"]`;
      await engineSeek(page, item.start - 40);
      await expect(page.locator(selector)).toHaveCount(0);
      await engineSeek(page, item.start + item.dur + 60);
      await expect(page.locator(selector)).toHaveCount(1);
    }
  });

  test("scene changes clear the board", async ({ page }) => {
    const tl = await timelineInfo(page);
    const s1 = tl.scenes[1];
    await engineSeek(page, s1.start + 700);
    const ids = await page.locator('[data-testid="board-items"] [data-id]').evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
    const scene0 = new Set(tl.items.filter((i) => i.scene === 0).map((i) => i.id));
    const scene1 = new Set(tl.items.filter((i) => i.scene === 1).map((i) => i.id));
    const leaked = ids.filter((id) => id && scene0.has(id) && !scene1.has(id));
    expect(leaked).toEqual([]);
  });

  test("whiteboard: write with the pen, erase, clear, and notes stay with their page", async ({ page }) => {
    await engineSeek(page, 8000);
    const svg = page.getByTestId("board-svg");
    const box = (await svg.boundingBox())!;
    const strokes = page.locator('[data-testid="user-strokes"] path');
    const draw = async (y: number) => {
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * (y + 0.05), { steps: 6 });
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * y, { steps: 6 });
      await page.mouse.up();
    };

    await page.getByRole("button", { name: /^Pen/ }).click();
    await draw(0.3);
    await expect(strokes).toHaveCount(1);
    await draw(0.45);
    await expect(strokes).toHaveCount(2);

    // Notes belong to their scene: another page of the lesson starts empty, and they come back.
    const tl = await timelineInfo(page);
    const scene = (await engineSnap(page)).scene;
    await engineSeek(page, tl.scenes[(scene + 1) % tl.scenes.length].start + 1500);
    await expect(strokes).toHaveCount(0);
    await engineSeek(page, 8000);
    await expect(strokes).toHaveCount(2);

    // Eraser removes the stroke it touches.
    await page.getByRole("button", { name: /^Eraser/ }).click();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.32, { steps: 4 });
    await page.mouse.up();
    await expect(strokes).toHaveCount(1);

    await page.getByRole("button", { name: "Clear my notes" }).click();
    await expect(strokes).toHaveCount(0);
  });

  test("whiteboard: zoom, pan and reset", async ({ page }) => {
    test.skip(isPhone(page), "zoom buttons are hidden on phones (pinch is used instead)");
    await engineSeek(page, 8000);
    const svg = page.getByTestId("board-svg");
    const vb = async () => (await svg.getAttribute("viewBox"))!.split(" ").map(Number);
    expect((await vb())[2]).toBe(1280);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const zoomed = await vb();
    expect(zoomed[2]).toBeLessThan(800);
    // Drag to pan (the hand tool is the default).
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5, { steps: 6 });
    await page.mouse.up();
    expect((await vb())[0]).toBeGreaterThan(zoomed[0]);
    await page.getByRole("button", { name: "Fit to screen" }).click();
    expect(await vb()).toEqual([0, 0, 1280, 800]);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await svg.dblclick({ position: { x: 60, y: 60 } });
    expect((await vb())[2]).toBe(1280);
  });

  test("full screen toggles", async ({ page }) => {
    const btn = page.getByRole("button", { name: "Full screen" });
    test.skip((await btn.count()) === 0, "Fullscreen API unavailable in this browser");
    await btn.click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.getByRole("button", { name: "Exit full screen" }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  });

  test("layout: no horizontal scrolling and the controls are reachable", async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const play = page.getByTestId("play-pause");
    if (isDesktop(page)) {
      // The whole player fits in the viewport without scrolling.
      const b = (await play.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      const board = (await page.getByTestId("whiteboard").boundingBox())!;
      expect(board.width).toBeGreaterThan(520);
    } else {
      await expect(play).toBeVisible();
    }
  });

  test("every control fits on one screen of a small phone (320-390px) and nothing is cut off", async ({ page }) => {
    test.skip(!isDesktop(page), "resizes the viewport itself, so one project is enough");
    const box = async (loc: ReturnType<Page["getByRole"]>) => (await loc.boundingBox())!;
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 740 });
      const panel = await box(page.getByRole("group", { name: "Lesson player" }));
      const scrub = await box(page.getByTestId("scrubber"));
      const time = await box(page.getByTestId("time-label"));
      // Left to right: restart, back 5s, play, forward 5s, speed, captions - in one row, never overlapping.
      const row = [
        await box(page.getByRole("button", { name: "Restart" })),
        await box(page.getByRole("button", { name: "Back 5 seconds" })),
        await box(page.getByTestId("play-pause")),
        await box(page.getByRole("button", { name: "Forward 5 seconds" })),
        await box(page.getByTestId("speed")),
        await box(page.getByRole("button", { name: /captions/i })),
      ];
      for (let i = 0; i < row.length - 1; i++) {
        expect(row[i].x + row[i].width, `${width}px: control ${i} overlaps control ${i + 1}`).toBeLessThanOrEqual(row[i + 1].x + 0.5);
        expect(Math.abs(row[i].y + row[i].height / 2 - (row[i + 1].y + row[i + 1].height / 2)), `${width}px: controls wrap`).toBeLessThan(14);
      }
      const last = row[row.length - 1];
      expect(last.x + last.width, `${width}px: last control is cut off`).toBeLessThanOrEqual(panel.x + panel.width);
      expect(scrub.x + scrub.width, `${width}px: time overlaps the scrubber`).toBeLessThanOrEqual(time.x + 0.5);
      expect(time.x + time.width).toBeLessThanOrEqual(panel.x + panel.width);
      expect(Math.abs(row[2].width - row[2].height), "play button stays a circle").toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    }
  });

  test("on phones the player stays pinned while the chat scrolls", async ({ page }) => {
    test.skip(!isPhone(page), "phone layout only");
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(250);
    const top = await page.getByTestId("stage").evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBeLessThan(40);
    await expect(page.getByTestId("play-pause")).toBeInViewport();
  });
});

test.describe("shared lesson", () => {
  test("viewers who are not the owner can watch but not ask", async ({ page }) => {
    await quietPrefs(page);
    await mockApi(page, { lesson: lessonDto({ isOwner: false }) });
    await openLesson(page);
    await expect(page.getByText(/viewing a shared lesson/i)).toBeVisible();
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Start your own" })).toBeVisible();
    await page.getByTestId("start-overlay").click();
    await expect.poll(async () => (await engineSnap(page)).playing).toBe(true);
  });
});

test.describe("follow-up questions", () => {
  const answer = (id = "m-answer") =>
    lessonMessage({ id, text: answerScript.summary, script: answerScript, suggestions: answerScript.suggestions });
  const userMsg = (text: string) => ({ id: "m-user", role: "user" as const, text, script: null, suggestions: [], voiceMode: "browser" as const, clips: [], createdAt: new Date().toISOString() });

  test.beforeEach(async ({ page }) => {
    await quietPrefs(page);
  });

  test("asking pauses the lesson, shows the answer, plays it, and the lesson can be resumed", async ({ page }) => {
    const asked: Record<string, unknown>[] = [];
    await mockApi(page, {
      ask: { status: 201, delayMs: 700, body: { user: userMsg("Why do opposite poles attract?"), assistant: answer() } },
      askSpy: (b) => asked.push(b),
    });
    await openLesson(page);
    await page.getByTestId("start-overlay").click();
    await expect.poll(async () => (await engineSnap(page)).time).toBeGreaterThan(2500);

    const box = page.getByTestId("composer-input");
    await box.fill("Why do opposite poles attract?");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("typing")).toBeVisible();
    await expect(box).toBeDisabled();
    expect((await engineSnap(page)).playing).toBe(false); // the lesson paused while asking

    await expect(page.getByTestId("answer-card")).toBeVisible();
    await expect(page.getByTestId("user-message")).toContainText("opposite poles");
    await expect(page.getByTestId("assistant-message").last()).toContainText("field lines");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ text: "Why do opposite poles attract?", sceneIndex: 0 });
    expect(typeof asked[0].spokenSoFar).toBe("string"); // context: what the learner had just heard

    // The answer takes over the board and starts playing by itself.
    await expect.poll(async () => (await engineSnap(page)).duration).toBeLessThan(20_000);
    await expect.poll(async () => (await engineSnap(page)).playing).toBe(true);
    await expect(page.getByTestId("stage").getByText("Answer", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("resume-banner")).toBeVisible();
    await expect(box).toHaveValue(""); // the question box was cleared

    // When the answer ends, go back to where the lesson was.
    const { duration } = await engineSnap(page);
    await engineSeek(page, duration - 300);
    await expect(page.getByTestId("resume-lesson")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("resume-lesson").click();
    await expect.poll(async () => (await engineSnap(page)).duration).toBeGreaterThan(60_000);
    const s = await engineSnap(page);
    expect(s.playing).toBe(true);
    expect(s.time).toBeGreaterThan(2000); // resumed near where it was paused, not from the start
    await expect(page.getByTestId("resume-banner")).toHaveCount(0);
  });

  test("suggested questions can be clicked", async ({ page }) => {
    const asked: Record<string, unknown>[] = [];
    await mockApi(page, {
      ask: { status: 201, body: { user: userMsg(script.suggestions[0]), assistant: answer() } },
      askSpy: (b) => asked.push(b),
    });
    await openLesson(page);
    const chip = page.getByTestId("suggestions").getByRole("button").first();
    await expect(chip).toHaveText(script.suggestions[0]);
    await chip.click();
    await expect(page.getByTestId("answer-card")).toBeVisible();
    expect(asked[0].text).toBe(script.suggestions[0]);
    // New suggestions come from the answer.
    await expect(page.getByTestId("suggestions").getByRole("button").first()).toHaveText(answerScript.suggestions[0]);
  });

  test("Enter sends, Shift+Enter adds a line, empty questions cannot be sent", async ({ page }) => {
    const asked: Record<string, unknown>[] = [];
    await mockApi(page, { ask: { status: 201, body: { user: userMsg("q"), assistant: answer() } }, askSpy: (b) => asked.push(b) });
    await openLesson(page);
    const box = page.getByTestId("composer-input");
    const send = page.getByTestId("composer-send");
    await expect(send).toBeDisabled();
    await box.fill("   ");
    await expect(send).toBeDisabled();
    await box.fill("first line");
    await box.press("Shift+Enter");
    await box.pressSequentially("second line");
    await expect(box).toHaveValue("first line\nsecond line");
    expect(asked).toHaveLength(0);
    await box.press("Enter");
    await expect(page.getByTestId("answer-card")).toBeVisible();
    expect(asked[0].text).toBe("first line\nsecond line");
  });

  test("a failed question shows the reason, keeps the text, and can be retried", async ({ page }) => {
    await mockApi(page, { ask: { status: 429, body: errorBody("rate_limited", "You're going a bit fast! Please wait about 3 minutes and try again.") } });
    await openLesson(page);
    const box = page.getByTestId("composer-input");
    await box.fill("Why is the sky blue?");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("ask-error")).toContainText("going a bit fast");
    await expect(box).toHaveValue("Why is the sky blue?");
    await expect(page.getByTestId("user-message")).toHaveCount(0); // the optimistic message was rolled back
    await expect(box).toBeEnabled();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("ask-error")).toHaveCount(0);
  });

  test("an answer without drawings (refusal or small talk) is just a chat message", async ({ page }) => {
    const plain = lessonMessage({ id: "m-plain", text: "Happy to help! Ask me anything about magnets.", script: null, suggestions: ["How do magnets work?"] });
    await mockApi(page, { ask: { status: 201, body: { user: userMsg("thanks!"), assistant: plain } } });
    await openLesson(page);
    await page.getByTestId("composer-input").fill("thanks!");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("Happy to help");
    await expect(page.getByTestId("answer-card")).toHaveCount(0);
    expect((await engineSnap(page)).playing).toBe(false);
    await expect(page.getByTestId("resume-banner")).toHaveCount(0);
  });

  test("questions are limited to 500 characters", async ({ page }) => {
    await mockApi(page);
    await openLesson(page);
    await page.getByTestId("composer-input").fill("x".repeat(520));
    await expect(page.getByTestId("composer-send")).toBeDisabled();
    await expect(page.getByText("520/500")).toBeVisible();
    await page.getByTestId("composer-input").fill("x".repeat(480));
    await expect(page.getByTestId("composer-send")).toBeEnabled();
  });
});

test.describe("loading and errors", () => {
  test("a missing lesson gets a clear page with a way forward", async ({ page }) => {
    await quietPrefs(page);
    await mockApi(page, { lesson: null });
    await page.goto("/lesson/nope123");
    await expect(page.getByTestId("load-error")).toContainText("Lesson not found");
    await page.getByRole("link", { name: /start a new lesson/i }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("a server error can be retried", async ({ page }) => {
    await quietPrefs(page);
    let broken = true; // (React StrictMode loads twice in dev, so the failure is held, not counted)
    await mockApi(page);
    await page.route(`**/api/lessons/${LESSON_ID}`, (route) => {
      if (route.request().method() === "GET" && broken) {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify(errorBody("internal", "Something went wrong on our side. Please try again.")) });
      }
      return route.fallback();
    });
    await page.goto(`/lesson/${LESSON_ID}`);
    await expect(page.getByTestId("load-error")).toContainText("Couldn't load the lesson");
    broken = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("stage")).toBeVisible();
    await expect(page.getByTestId("start-overlay")).toBeVisible();
  });

  test("an unknown URL shows the 404 page", async ({ page }) => {
    const res = await page.goto("/no/such/page");
    expect(res?.status()).toBe(404);
    await expect(page.getByText("This page isn't on the board")).toBeVisible();
  });
});

test.describe("history", () => {
  test.beforeEach(async ({ page }) => {
    await quietPrefs(page);
  });

  test("lists lessons, opens one, and closes with Escape", async ({ page }) => {
    await mockApi(page);
    await openLesson(page);
    await page.getByTestId("open-history").click();
    await expect(page.getByRole("dialog", { name: "Lesson history" })).toBeVisible();
    await expect(page.getByTestId("history-item")).toHaveCount(summaries.length);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByTestId("open-history").click();
    await page.getByTestId("history-item").nth(1).click();
    await expect(page).toHaveURL(/\/lesson\/fx2$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("deleting asks for confirmation and removes the lesson", async ({ page }) => {
    let deleted = 0;
    await mockApi(page, { onDelete: () => deleted++ });
    await openLesson(page);
    await page.getByTestId("open-history").click();
    await page.getByRole("button", { name: "Delete The Water Cycle" }).click();
    await page.getByRole("button", { name: "Cancel" }).click(); // changed our mind
    await expect(page.getByTestId("history-item")).toHaveCount(2);
    expect(deleted).toBe(0);
    await page.getByRole("button", { name: "Delete The Water Cycle" }).click();
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("history-item")).toHaveCount(1);
    expect(deleted).toBe(1);
  });

  test("deleting the lesson you are watching returns home", async ({ page }) => {
    await mockApi(page);
    await openLesson(page);
    await page.getByTestId("open-history").click();
    await page.getByRole("button", { name: "Delete How Magnets Work" }).click();
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("an empty history explains what to do", async ({ page }) => {
    await mockApi(page, { lessons: [] });
    await page.goto("/");
    await page.getByTestId("open-history").click();
    await expect(page.getByText(/no lessons yet/i)).toBeVisible();
  });
});
