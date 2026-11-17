import { expect, test, type Page } from "@playwright/test";

/**
 * The real thing: Gemini writes a lesson, ElevenLabs records it, Neon stores it, and the browser
 * plays it. Spends API credits - run with E2E_LIVE=1.
 */
test.skip(!process.env.E2E_LIVE, "Set E2E_LIVE=1 to run the live end-to-end journey (uses API credits).");

type Snap = { time: number; duration: number; playing: boolean; buffering: boolean; ended: boolean; scene: number; rate: number; muted: boolean };
const snap = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wbt: { engine: { getSnapshot(): unknown } } }).__wbt.engine.getSnapshot() as Snap);
const mode = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wbt: { active: { source: { mode: string } } } }).__wbt.active.source.mode);

test("learn a topic end to end: generate, narrate, play, seek, ask, resume, history", async ({ page }) => {
  test.setTimeout(420_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  await test.step("start a lesson from the home page", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /learn anything/i })).toBeVisible();
    await page.getByTestId("topic-input").fill("How do magnets work?");
    await page.getByTestId("start-lesson").click();
    await expect(page.getByTestId("generating")).toBeVisible();
    await expect(page).toHaveURL(/\/lesson\/[0-9A-Za-z]+$/, { timeout: 150_000 });
  });

  await test.step("narration is recorded, then the lesson is ready to play", async () => {
    await expect(page.getByTestId("start-overlay")).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId("lesson-card")).toBeVisible();
    expect(await mode(page)).toBe("audio"); // studio voice, not the browser fallback
    const s = await snap(page);
    expect(s.duration).toBeGreaterThan(45_000); // roughly a 1-2.5 minute lesson (shorter if a fast fallback model wrote it)
    expect(s.duration).toBeLessThan(200_000);
    expect(await page.locator('[data-testid^="card-chapter-"]').count()).toBeGreaterThanOrEqual(4);
  });

  await test.step("play: audio drives the clock, the board fills in, captions appear", async () => {
    await page.getByTestId("start-overlay").click();
    await expect.poll(async () => (await snap(page)).time, { timeout: 15_000 }).toBeGreaterThan(3000);
    const s = await snap(page);
    expect(s.playing).toBe(true);
    expect(s.buffering).toBe(false);
    await expect.poll(() => page.locator('[data-testid="board-items"] [data-id]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("captions")).not.toContainText("Captions appear here");
  });

  await test.step("pause holds the position; play resumes", async () => {
    await page.getByTestId("play-pause").click();
    const paused = await snap(page);
    expect(paused.playing).toBe(false);
    await page.waitForTimeout(1500);
    expect((await snap(page)).time).toBe(paused.time);
    await page.getByTestId("play-pause").click();
    await expect.poll(async () => (await snap(page)).time, { timeout: 10_000 }).toBeGreaterThan(paused.time + 800);
  });

  await test.step("seek with the scrubber and with chapters", async () => {
    const before = await snap(page);
    const target = Math.round(before.duration * 0.6);
    await page.getByTestId("scrubber").evaluate((el, v) => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, target);
    await expect.poll(async () => Math.abs((await snap(page)).time - target), { timeout: 8000 }).toBeLessThan(1500);
    expect((await snap(page)).scene).toBeGreaterThanOrEqual(2);

    await page.getByTestId("card-chapter-1").click();
    await expect.poll(async () => (await snap(page)).scene, { timeout: 8000 }).toBe(1);
    await expect.poll(async () => (await snap(page)).playing).toBe(true);
  });

  await test.step("speed, restart and keyboard shortcuts", async () => {
    await page.getByTestId("speed").selectOption("1.5");
    expect((await snap(page)).rate).toBe(1.5);
    await page.getByTestId("speed").selectOption("1");
    await page.getByRole("button", { name: "Restart" }).click();
    await expect.poll(async () => (await snap(page)).time, { timeout: 5000 }).toBeLessThan(2500);
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("Space");
    await expect.poll(async () => (await snap(page)).playing).toBe(false);
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await snap(page)).time).toBeGreaterThan(4000);
  });

  let lessonTime = 0;
  await test.step("ask a follow-up: it answers in text, voice and drawing", async () => {
    await page.getByTestId("card-chapter-1").click(); // be somewhere mid-lesson
    await page.waitForTimeout(1500);
    lessonTime = (await snap(page)).time;
    await page.getByTestId("composer-input").fill("Why do opposite poles attract?");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("typing")).toBeVisible();
    expect((await snap(page)).playing).toBe(false); // asking pauses the lesson
    await expect(page.getByTestId("answer-card")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("user-message")).toContainText("opposite poles");
    // The answer starts playing by itself once its narration is ready.
    await expect.poll(async () => (await snap(page)).playing, { timeout: 90_000 }).toBe(true);
    expect(await mode(page)).toBe("audio");
    await expect(page.getByText("Answer", { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.locator('[data-testid="board-items"] [data-id]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("resume-banner")).toBeVisible();
  });

  await test.step("return to the lesson where it was left", async () => {
    const dur = (await snap(page)).duration;
    await page.evaluate((d) => (window as unknown as { __wbt: { engine: { seek(n: number): void } } }).__wbt.engine.seek(d - 600), dur);
    await expect(page.getByTestId("resume-lesson")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("resume-lesson").click();
    await expect.poll(async () => (await snap(page)).playing).toBe(true);
    const s = await snap(page);
    expect(Math.abs(s.time - lessonTime)).toBeLessThan(3500);
    expect(s.duration).toBeGreaterThan(45_000); // back on the main lesson timeline
  });

  await test.step("a reload restores the lesson and its recorded audio without re-recording", async () => {
    await page.reload();
    await expect(page.getByTestId("start-overlay")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    expect(await mode(page)).toBe("audio");
  });

  await test.step("history lists the lesson and deleting it works", async () => {
    await page.getByTestId("open-history").click();
    await expect(page.getByTestId("history-item").first()).toContainText(/magnet/i);
    await page.getByRole("button", { name: /^Delete/ }).first().click();
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  expect(consoleErrors, "no uncaught page errors during the journey").toEqual([]);
});
