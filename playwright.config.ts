import { defineConfig, devices } from "@playwright/test";

// Tests that talk to the database directly need the same variables as the app.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* variables may come from the real environment (CI) */
}

const PORT = Number(process.env.E2E_PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * End-to-end tests.
 *  - `ui` and `api` specs need no paid services (APIs are mocked / the database is seeded directly).
 *  - `live` specs run the real Gemini + ElevenLabs + Neon pipeline and spend credits; they only run
 *    when E2E_LIVE=1 (see README).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000, // live specs raise this for themselves
  expect: { timeout: 10_000 },
  // A locator that cannot be clicked fails quickly instead of waiting for the whole test timeout.
  // (set per action below)
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: /(live|api)\.spec\.ts/ },
    { name: "tablet", use: { ...devices["iPad (gen 7)"], browserName: "chromium" }, testMatch: /ui\.spec\.ts/ },
  ],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
