/**
 * I2 — Onboarding wizard, DOM end-to-end (TER-596 / TER-599). The render-tests
 * cover PlanStep/PaymentStep in isolation; THIS spec drives the real wizard in a
 * fresh browser as a user: it logs in a pre-onboarding user (redirect gate fires),
 * walks Welcome → skip → PlanStep, and:
 *   - picks Starter (free) → reaches Done → asserts Mongo onboardingCompletedAt +
 *     plan_starter.
 *   - picks Growth (paid) → fills the real Stripe Elements 4242 iframe →
 *     confirmSetup → reaches Done → asserts Mongo plan_growth + a vaulted card.
 *   - Enterprise is contact-sales only (not selectable, can't finish onboarding).
 *
 * Fresh context per test (no storageState) so localStorage carries no stale
 * onboardingCompletedAt. seedOnboardingUser() resets the dedicated throwaway user
 * to pre-onboarding state each run, apart from playwright1/2's shared baseline.
 */
import { expect, test } from "../fixtures"
import {
  getActiveSub,
  getBillingCustomer,
  getUser,
  ONB_EMAIL,
  ONB_PASSWORD,
  ONB_USER,
  seedOnboardingUser,
} from "../helpers/billing"
import { closeDb } from "../helpers/db"
import { fillStripeCard, loginForOnboarding } from "../helpers/dom"

const CREDS = { email: ONB_EMAIL, password: ONB_PASSWORD }

test.beforeEach(async () => {
  await seedOnboardingUser()
})
test.afterAll(async () => {
  await closeDb()
})

/** Welcome (after splash) → Continue → ProviderStep → Skip → lands on PlanStep. */
async function walkToPlanStep(page: import("@playwright/test").Page): Promise<void> {
  // The splash animation (~5s) plays before WelcomeStep mounts its footer.
  const cont = page.getByTestId("step-footer-continue")
  await cont.waitFor({ state: "visible", timeout: 25_000 })
  await cont.click()
  // ProviderStep → Skip jumps straight to the (mandatory) PlanStep.
  const skip = page.getByTestId("step-footer-skip")
  await skip.waitFor({ state: "visible", timeout: 10_000 })
  await skip.click()
  await page.getByTestId("plan-card-plan_starter").waitFor({ state: "visible", timeout: 10_000 })
}

test.describe("billing — onboarding wizard I2 @billing", () => {
  test("plan obligatorio: Continue bloqueado hasta elegir, Starter free llega a Done", async ({
    browser,
  }) => {
    test.setTimeout(90_000)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await loginForOnboarding(page, CREDS)
      await walkToPlanStep(page)

      // Mandatory gate: with nothing selected, Continue is disabled (continueDisabled
      // while selectedId === null) — the user cannot finish without a plan.
      await expect(
        page.getByTestId("step-footer-continue"),
        "Continue bloqueado sin plan elegido",
      ).toBeDisabled()

      // Pick Starter (the seeded current plan) → Continue enables → SAME_PLAN path → Done.
      await page.getByTestId("plan-card-plan_starter").click()
      await expect(
        page.getByTestId("step-footer-continue"),
        "elegir plan habilita Continue",
      ).toBeEnabled()
      await page.getByTestId("step-footer-continue").click()

      // DoneStep renders the special CTA + on mount fires profile.complete-onboarding.
      await expect(page.getByTestId("step-footer-cta")).toBeVisible({ timeout: 15_000 })

      // Mongo: onboarding marked complete + still on Starter.
      await expect
        .poll(async () => (await getUser(ONB_USER))?.onboardingCompletedAt ?? null, {
          timeout: 10_000,
          message: "onboardingCompletedAt persistido",
        })
        .not.toBeNull()
      const sub = await getActiveSub(ONB_USER)
      expect(sub?.planId, "sigue en Starter (free)").toBe("plan_starter")
    } finally {
      await context.close()
    }
  })

  test("Growth (de pago): Stripe Elements 4242 → confirmSetup → activa plan_growth", async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await loginForOnboarding(page, CREDS)
      await walkToPlanStep(page)

      // Pick a PAID plan → wizard advances to the PaymentStep (Stripe Elements).
      await page.getByTestId("plan-card-plan_growth").click()
      await page.getByTestId("step-footer-continue").click()

      await page.getByTestId("payment-element").waitFor({ state: "visible", timeout: 25_000 })
      await fillStripeCard(page)

      // Confirm → confirmSetup (vault) → set-payment-method → change-plan.
      await page.getByTestId("step-footer-continue").click()

      // No inline payment error, and we reach Done.
      await expect(page.getByTestId("payment-error")).toHaveCount(0)
      await expect(page.getByTestId("step-footer-cta")).toBeVisible({ timeout: 30_000 })

      // Mongo: plan activated to Growth + onboarding complete + a card vaulted.
      await expect
        .poll(async () => (await getActiveSub(ONB_USER))?.planId, {
          timeout: 15_000,
          message: "plan activado a Growth",
        })
        .toBe("plan_growth")
      await expect
        .poll(async () => (await getUser(ONB_USER))?.onboardingCompletedAt ?? null, {
          timeout: 10_000,
        })
        .not.toBeNull()
      const cust = await getBillingCustomer(ONB_USER)
      expect(cust?.defaultPaymentMethodId, "tarjeta vaulteada como default").toBeTruthy()
      expect(cust?.stripeCustomerId, "stripe customer creado").toBeTruthy()
    } finally {
      await context.close()
    }
  })

  test("Enterprise es contact-sales: no seleccionable, no completa onboarding", async ({
    browser,
  }) => {
    test.setTimeout(90_000)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    // Capturar window.open ANTES de cargar la página: RN-Web Linking.openURL llama
    // a window.open(url, '_blank', 'noopener') (sin target → _blank). Lo interceptamos
    // para asertar que "Talk to sales" dispara el mailto correcto, sin abrir nada.
    await page.addInitScript(() => {
      // biome-ignore lint/suspicious/noExplicitAny: window override
      ;(window as any).__opened = []
      window.open = ((url?: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: window override
        ;(window as any).__opened.push(String(url ?? ""))
        return null
      }) as typeof window.open
    })
    try {
      await loginForOnboarding(page, CREDS)
      await walkToPlanStep(page)

      // Enterprise shows a "Talk to sales" CTA instead of a selectable card.
      await expect(page.getByTestId("plan-contact-sales")).toBeVisible()
      await page.getByTestId("plan-contact-sales").click()

      // El CTA dispara el mailto de ventas (Linking.openURL → window.open interceptado).
      await expect
        .poll(
          async () =>
            // biome-ignore lint/suspicious/noExplicitAny: window global
            (await page.evaluate(() => (window as any).__opened as string[])).join("|"),
          { timeout: 5000, message: "Talk to sales abre el mailto de ventas" },
        )
        .toContain("mailto:sales@teros.ai")

      // Y NO completa el onboarding (sigue en PlanStep, sin onboardingCompletedAt).
      await expect(page.getByTestId("plan-card-plan_starter")).toBeVisible()
      const user = await getUser(ONB_USER)
      expect(
        user?.onboardingCompletedAt ?? null,
        "Enterprise no completa el onboarding self-serve",
      ).toBeNull()
    } finally {
      await context.close()
    }
  })
})
