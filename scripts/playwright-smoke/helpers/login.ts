/**
 * Teros login flow + RN-Web gotchas — the SINGLE source (ported from lib.js).
 * Sign in with email → ToS welcome → onboarding skip → navbar hydration.
 */
import type { Page } from "@playwright/test"
import { CONFIG, type Creds } from "./config"

export type { Creds }

export async function login(page: Page, creds: Creds, label = ""): Promise<void> {
  const tag = label ? `[${label}] ` : ""
  console.log(`${tag}login as ${creds.email}`)
  await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle", timeout: 30000 })
  await page.waitForTimeout(1500)

  // Deterministic login: a fresh context shouldn't carry a session, but the dev app can
  // rehydrate a persisted one (possibly a different user). If we're not on /login, wipe
  // client state + cookies and reload so we always authenticate as `creds` — otherwise
  // the flow skips the form and fails on the absent email input.
  if (!page.url().includes("/login")) {
    await page.evaluate(() => {
      try {
        localStorage.clear()
        sessionStorage.clear()
      } catch {
        // storage may be inaccessible on the current origin; ignore
      }
    })
    await page.context().clearCookies()
    await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle", timeout: 30000 })
    await page.waitForTimeout(1500)
  }

  if (page.url().includes("/login") && !page.url().includes("/login/email")) {
    await page.locator("text=Sign in with email").first().click()
    await page.waitForURL("**/login/email", { timeout: 5000 })
  }
  await page.waitForTimeout(400)

  await page.locator("input[type=email]").fill(creds.email)
  await page.locator("input[type=password]").fill(creds.password)
  await page.locator('button:has-text("Sign in")').first().click()
  await page.waitForTimeout(2500)

  // ToS welcome — checkbox is a row; click to the left of the text label.
  if (page.url().includes("/login/welcome")) {
    const tosRow = page.locator("text=/I understand that Teros is in early alpha/").first()
    const box = await tosRow.boundingBox()
    if (box) await page.mouse.click(box.x - 18, box.y + box.height / 2)
    await page.waitForTimeout(500)
    await page.locator('button:has-text("Get started")').first().click({ force: true })
    await page.waitForTimeout(2500)
  }

  // Onboarding wizard — re-hit root to skip.
  if (page.url().includes("/login/onboarding")) {
    await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle" })
    await page.waitForTimeout(1500)
  }

  await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), null, {
    timeout: 20000,
  })
  await page.waitForTimeout(3000) // navbar hydration
  console.log(`${tag}logged in @ ${page.url()}`)
}
