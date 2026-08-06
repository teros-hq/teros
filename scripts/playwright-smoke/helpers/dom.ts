/**
 * DOM-interaction helpers for the @billing UI specs (FASE 2). Where the
 * backend-contract specs drive window.teros + assert Mongo, these specs OPEN the
 * real windows, click real controls, fill the real Stripe iframe and read the
 * rendered widgets — as a user would. RN-Web has no ARIA roles, so we anchor on
 * the testIDs added to the components (data-testid on web).
 */
import { expect, type Page } from "@playwright/test"
import { CONFIG, type Creds } from "./config"
import { evalTeros } from "./teros"

/**
 * Opens a tiling window via its Navbar entry (the nav items carry stable
 * `nav-*` testIDs; billing-teams/billing-requests have no route, only this path).
 * Clicks the nav item, then waits for a content anchor of the opened window.
 */
export async function openViaNav(
  page: Page,
  navTestId: string,
  waitForTestId: string,
): Promise<void> {
  await page.getByTestId(navTestId).click({ timeout: 10_000 })
  await page.getByTestId(waitForTestId).first().waitFor({ state: "visible", timeout: 15_000 })
}

/**
 * Fills the Stripe PaymentElement with the test card 4242. Stripe mounts several
 * cross-origin iframes (`__privateStripeFrame*`): a loader, an accessory, and the
 * "easel" that holds the actual inputs. We resolve the easel frame from
 * page.frames() (its URL carries `elements-inner-easel`/`payment`) and fill the
 * card fields by their stable input `name`s (number/expiry/cvc/postalCode) — far
 * more robust than placeholders, which are localized and change across versions.
 */
export async function fillStripeCard(page: Page, card = "4242424242424242"): Promise<void> {
  // Poll page.frames() until the inputs frame is attached + loaded.
  let frame: import("@playwright/test").Frame | undefined
  for (let i = 0; i < 50; i++) {
    frame = page.frames().find((f) => /elements-inner-(easel|payment|card)/.test(f.url()))
    if (frame) {
      // Ensure the card number input exists inside it before we proceed.
      const ok = await frame
        .locator('input[name="number"]')
        .count()
        .then((c) => c > 0)
        .catch(() => false)
      if (ok) break
      frame = undefined
    }
    await page.waitForTimeout(400)
  }
  if (!frame) throw new Error("fillStripeCard: no se encontró el iframe de inputs de Stripe")

  await frame.locator('input[name="number"]').fill(card)
  await frame.locator('input[name="expiry"]').fill("12 / 34")
  await frame.locator('input[name="cvc"]').fill("123")
  // Postal code only renders for some locales/cards — best-effort.
  const zip = frame.locator('input[name="postalCode"]')
  if (
    await zip
      .count()
      .then((c) => c > 0)
      .catch(() => false)
  ) {
    await zip.fill("28001").catch(() => {})
  }
}

/**
 * Creates a channel, names it, opens it via the sidebar (→ /chat/<id>) and waits
 * for the composer. Mirrors composer.spec's openChat — the deep-link goto doesn't
 * work (the app restores tiling state), the sidebar click does. Returns channelId.
 */
export async function openChat(
  page: Page,
  agentId: string,
  workspaceId: string,
  label: string,
): Promise<string> {
  const channelId = await evalTeros(
    page,
    async ({ aid, wid, label }) => {
      const r = await window.teros.channel.create({ agentId: aid, workspaceId: wid })
      await window.teros.channel.rename(r.channelId, label)
      return r.channelId
    },
    { aid: agentId, wid: workspaceId, label },
  )
  await page.waitForTimeout(2000) // let the sidebar receive the realtime channel
  await page.getByText(label, { exact: false }).first().click({ timeout: 10_000 })
  await page.waitForURL(`**/chat/${channelId}`, { timeout: 10_000 })
  await page.getByTestId("composer-input").waitFor({ state: "visible", timeout: 10_000 })
  return channelId
}

/**
 * Surfaces the BoostModal through the 80% warning banner: emits the usage-warning
 * the backend would broadcast at 80%, then clicks the banner CTA. The modal's
 * content (buy form / team request / unavailable) derives from the REAL
 * get-subscription, so it reflects the user's actual plan/team. Returns once
 * `boost-panel` is on screen.
 */
export async function openBoostModalViaBanner(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    ;(window as any).teros.emit("billing.usage-warning", {
      used: 64,
      limit: 80,
      boostHours: 0,
      threshold: 0.8,
      tier: "pro",
      planName: "Pro",
      periodEnd: "2026-07-08T00:00:00.000Z",
    })
  })
  await page.getByTestId("billing-warning-cta").click({ timeout: 10_000 })
  await page.getByTestId("boost-panel").waitFor({ state: "visible", timeout: 10_000 })
}

/** Waits for a toast of a given semantic type (testID `toast-<type>`) to appear. */
export async function expectToast(
  page: Page,
  type: "success" | "warning" | "error" | "info",
  timeout = 10_000,
): Promise<void> {
  await expect(page.getByTestId(`toast-${type}`).first()).toBeVisible({ timeout })
}

/**
 * Logs in as `creds` WITHOUT skipping the onboarding wizard. The standard
 * login() re-hits root to bypass /login/onboarding (for the seeded users that
 * already finished it); here we WANT the wizard, so we stop on it. Use in a fresh
 * context (browser.newContext, no storageState) so localStorage carries no stale
 * onboardingCompletedAt that would never-downgrade the redirect.
 */
export async function loginForOnboarding(page: Page, creds: Creds): Promise<void> {
  await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle", timeout: 30_000 })
  await page.waitForTimeout(1200)
  if (!page.url().includes("/login")) {
    await page.evaluate(() => {
      try {
        localStorage.clear()
        sessionStorage.clear()
      } catch {
        /* origin may block storage */
      }
    })
    await page.context().clearCookies()
    await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle", timeout: 30_000 })
    await page.waitForTimeout(1200)
  }
  if (page.url().includes("/login") && !page.url().includes("/login/email")) {
    await page.locator("text=Sign in with email").first().click()
    await page.waitForURL("**/login/email", { timeout: 5000 })
  }
  await page.waitForTimeout(400)
  await page.locator("input[type=email]").fill(creds.email)
  await page.locator("input[type=password]").fill(creds.password)
  await page.locator('button:has-text("Sign in")').first().click()

  // Wait for the auth to land (off /login) — the login screen persists the session.
  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), null, {
    timeout: 20_000,
  })

  // RELOAD to force a fresh root mount: only the session-restore path (app/_layout
  // onConnected) calls profile.get → setProfileSynced(), and the onboarding gate
  // requires isProfileSynced. A fresh login without a reload never flips it, so the
  // gate stays inert. After the reload, hydrate restores the just-saved session,
  // syncs the profile (no onboardingCompletedAt server-side) and the gate redirects.
  await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle", timeout: 30_000 })

  // termsAcceptedAt is seeded → no ToS gate. The workspace layout now redirects a
  // pre-onboarding user to /login/onboarding (gate: accessGranted && termsAcceptedAt
  // && !onboardingCompletedAt && isProfileSynced).
  await page.waitForURL("**/login/onboarding", { timeout: 25_000 })
}
