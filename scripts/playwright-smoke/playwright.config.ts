import { defineConfig } from "@playwright/test"
import { CONFIG } from "./helpers/config"

/**
 * Smoke suite config. Sequential (workers:1) on purpose: realtime + LLM scenarios
 * share live state and must not race. Run with the root scripts:
 *   yarn smoke           # full suite (includes @llm with real Kimi)
 *   yarn smoke:health    # @health only (~30s sanity)
 *   yarn smoke:no-llm    # everything except @llm (no Fireworks cost)
 * Requires the stack up (backend :10001 + Expo :8081) and `node seed.mjs`.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: ["setup/**/*.setup.ts", "tests/**/*.spec.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Retries absorb @llm/timing flakes (real-model latency). 0 locally so a determin-
  // istic regression shows as red while developing; 2 in CI for resilience.
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: `${__dirname}/.report`, open: "never" }]],
  use: {
    baseURL: CONFIG.targetUrl,
    viewport: { width: 1280, height: 900 },
    headless: process.env.HEADED ? false : true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    // Fake mic so the voice-recording spec can drive getUserMedia headlessly.
    permissions: ["microphone"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      // Only specs — the setup runs once via the `setup` dependency, not again here
      // (without this it inherits the global testMatch and re-runs auth.setup.ts).
      testMatch: /tests\/.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: { storageState: `${CONFIG.authDir}/user1.json` },
    },
  ],
})
