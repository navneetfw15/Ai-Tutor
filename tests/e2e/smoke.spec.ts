import { expect, test } from "@playwright/test";
import { LESSON_ID, mockApi, openLessonPlain, quietPrefs } from "./fixtures";

/**
 * Smoke test that works against ANY build, including `next build && next start` (it does not use the
 * development-only `window.__wbt` hook). Run it against production with:
 *   npm run build && npx next start -p 3100   (in one terminal)
 *   E2E_PORT=3100 npx playwright test smoke.spec.ts --project=desktop   (in another)
 */
test.describe("production smoke", () => {
  test("health check passes against the real database", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, database: "connected" });
  });

  test("pages are served with security headers and no framework banner", async ({ request }) => {
    const res = await request.get("/");
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("a lesson loads and plays with no page errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await quietPrefs(page);
    await mockApi(page);
    await openLessonPlain(page, LESSON_ID);
    await expect(page.getByTestId("start-overlay")).toBeVisible();
    await page.getByTestId("start-overlay").click();
    await expect(page.getByTestId("time-label")).not.toContainText("0:00 /", { timeout: 10_000 });
    await expect.poll(() => page.locator('[data-testid="board-items"] [data-id]').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.getByTestId("play-pause").click();
    await expect(page.getByTestId("play-pause")).toHaveAttribute("aria-label", "Play");
    expect(errors).toEqual([]);
  });

  test("the home page works and unknown routes are 404", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /learn anything/i })).toBeVisible();
    const res = await page.goto("/definitely/not/a/page");
    expect(res?.status()).toBe(404);
  });
});
