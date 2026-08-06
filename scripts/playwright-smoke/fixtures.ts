/**
 * Extended test with Teros-specific fixtures:
 *  - seed: seed.mjs fixtures (userIds, sharedWorkspaceId)
 *  - terosPage: a logged-in page (via storageState set by the project) with the
 *    event recorder installed and console/page/network errors captured. Falls back
 *    to a full login if storageState didn't rehydrate auth (R5).
 *  - secondUser1Page: a SECOND authenticated session of user1 (own context) — for
 *    same-user realtime fan-out (one session acts, the other must receive the push).
 *  - user2Page: an authenticated session of user2 (member of the shared workspace)
 *    — for cross-user realtime tests.
 *  - capturedErrors(page): read the captured errors for assertions.
 */
import { type Browser, test as base, type Page } from "@playwright/test"
import { CONFIG, type Creds, type Fixtures, loadFixtures } from "./helpers/config"
import { login } from "./helpers/login"
import { type CapturedErrors, getClientState, installEventRecorder } from "./helpers/teros"

const ERRORS = new WeakMap<Page, CapturedErrors>()

export function capturedErrors(page: Page): CapturedErrors {
  return ERRORS.get(page) || { console: [], page: [], network: [] }
}

function attachErrorCapture(page: Page): void {
  const bucket: CapturedErrors = { console: [], page: [], network: [] }
  ERRORS.set(page, bucket)
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text()))
      bucket.console.push(m.text())
  })
  page.on("pageerror", (e) => bucket.page.push(e.message))
  page.on("response", (r) => {
    if (r.status() >= 400) bucket.network.push(`${r.status()} ${r.url()}`)
  })
}

/**
 * Brings a page from "fresh context with storageState" to "authenticated, recorder
 * installed". The shared core of every page fixture. `fallbackCreds` is used if the
 * storageState didn't rehydrate the auth store (R5).
 */
async function bootstrap(page: Page, fallbackCreds: Creds, label: string): Promise<void> {
  attachErrorCapture(page)
  await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle", timeout: 30000 })
  await page.waitForTimeout(2000)

  let state = await getClientState(page)
  if (!state.ok || page.url().includes("/login")) {
    await login(page, fallbackCreds, label)
    state = await getClientState(page)
  }
  if (!state.ok)
    throw new Error(`No se pudo autenticar (${label}): ${(state as { reason?: string }).reason}`)

  await installEventRecorder(page)
}

/** Opens an own context from a storageState file, bootstrapped + recorder-ready. */
async function openSession(browser: Browser, storageState: string, creds: Creds, label: string) {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  await bootstrap(page, creds, label)
  return { context, page }
}

export const test = base.extend<{
  seed: Fixtures
  terosPage: Page
  secondUser1Page: Page
  user2Page: Page
  superPage: Page
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture sin dependencias
  seed: async ({}, use) => {
    await use(loadFixtures())
  },

  // Primary session — uses the project-level storageState (user1.json).
  terosPage: async ({ page }, use) => {
    await bootstrap(page, CONFIG.users.user1, "primary")
    await use(page)
  },

  // Second user1 session in its own context (same storageState) — same-user realtime.
  secondUser1Page: async ({ browser }, use) => {
    const { context, page } = await openSession(
      browser,
      `${CONFIG.authDir}/user1.json`,
      CONFIG.users.user1,
      "user1-b",
    )
    await use(page)
    await context.close()
  },

  // user2 session — cross-user realtime (member of the shared workspace).
  user2Page: async ({ browser }, use) => {
    const { context, page } = await openSession(
      browser,
      `${CONFIG.authDir}/user2.json`,
      CONFIG.users.user2,
      "user2",
    )
    await use(page)
    await context.close()
  },

  // super-admin session (user3) — core-rollout.spec.ts (super-only ops).
  superPage: async ({ browser }, use) => {
    const { context, page } = await openSession(
      browser,
      `${CONFIG.authDir}/user3.json`,
      CONFIG.users.user3,
      "super",
    )
    await use(page)
    await context.close()
  },
})

export { expect } from "@playwright/test"
