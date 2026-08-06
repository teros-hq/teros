/**
 * I3 — Profile → Plan, DOM (TER-596 / TER-600). The backend-contract spec
 * (billing-profile-plan) drives get-subscription/preview/change through the
 * client; THIS spec opens the real ProfileWindow as playwright2, enters the plan
 * section, and operates the rendered UI: reads the UsageHero + PricingCards +
 * PaymentMethodCard, runs a plan change through the inline preview + confirm, and
 * surfaces the invoice list — then asserts the raw Mongo effect.
 *
 * Each test rebaselines playwright2 to plan_pro 40/80h; afterAll restores it.
 */

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import {
  getActiveSub,
  insertInvoice,
  KIMI_USER,
  resetKimiBaseline,
  setCancelAtPeriodEnd,
} from "../helpers/billing"
import { closeDb } from "../helpers/db"
import { openViaNav } from "../helpers/dom"

/** nav → Profile window (view) → enter the plan section → wait for the hero. */
async function openProfilePlan(page: Page): Promise<void> {
  await openViaNav(page, "nav-profile", "profile-open-plan")
  await page.getByTestId("profile-open-plan").click()
  await page.getByTestId("plan-hero").waitFor({ state: "visible", timeout: 15_000 })
}

test.beforeEach(async () => {
  await resetKimiBaseline()
})
test.afterAll(async () => {
  await resetKimiBaseline()
  await closeDb()
})

test.describe("billing — perfil → plan I3 (DOM) @billing", () => {
  test("la sección de plan renderiza hero + barra de uso + tarjeta", async ({ user2Page }) => {
    test.setTimeout(60_000)
    await openProfilePlan(user2Page)

    // UsageHero: el plan activo (Pro) y su uso real (40 / 80) están en pantalla.
    await expect(user2Page.getByTestId("plan-hero")).toBeVisible()
    await expect(user2Page.getByTestId("plan-hero")).toContainText("Pro")
    await expect(user2Page.getByTestId("usage-bar")).toBeVisible()
    // La PricingCard de Pro está marcada como la actual.
    await expect(user2Page.getByTestId("current-badge-plan_pro")).toBeVisible()
    // PaymentMethodCard: una tarjeta vaulteada (····NNNN).
    await expect(user2Page.getByTestId("payment-card-display")).toBeVisible()
    await expect(user2Page.getByTestId("payment-card-display")).toContainText(/\d{4}/)
  })

  test("cambiar de plan: el preview muestra el importe y al confirmar aplica el upgrade", async ({
    user2Page,
  }) => {
    test.setTimeout(60_000) // el upgrade cobra proración vía Stripe (best-effort)
    await openProfilePlan(user2Page)

    // Click en la PricingCard de Ultra (upgrade) → confirmación inline con el preview.
    await user2Page.getByTestId("cta-plan_ultra").click()
    await expect(user2Page.getByTestId("change-confirm")).toBeVisible({ timeout: 10_000 })
    // El preview del cargo prorrateado se resuelve a un importe real (€), no al placeholder.
    await expect(user2Page.getByTestId("change-preview-amount")).toBeVisible()
    await expect
      .poll(
        async () => (await user2Page.getByTestId("change-preview-amount").textContent()) ?? "",
        { timeout: 10_000, message: "el preview deja de cargar y muestra el importe" },
      )
      .toMatch(/€|\d/)

    // Confirmar → change-plan (upgrade inmediato) → toast + recarga.
    await user2Page.getByTestId("change-confirm-apply").click()
    await expect(user2Page.getByTestId("toast-success").first()).toBeVisible({ timeout: 20_000 })

    // Mongo crudo: la sub activa ahora es Ultra (F8 upgrade inmediato).
    await expect
      .poll(async () => (await getActiveSub(KIMI_USER))?.planId, {
        timeout: 15_000,
        message: "el upgrade se aplicó a Ultra",
      })
      .toBe("plan_ultra")
  })

  test("gestionar método de pago: el toggle abre el formulario de Stripe", async ({
    user2Page,
  }) => {
    test.setTimeout(60_000)
    await openProfilePlan(user2Page)

    await user2Page.getByTestId("manage-payment").click()
    // El formulario de tarjeta (PaymentMethodSetup) aparece con el Stripe Element.
    await expect(user2Page.getByTestId("payment-method-form")).toBeVisible({ timeout: 15_000 })
  })

  test("facturas: la fila del historial se renderiza con su número", async ({ user2Page }) => {
    test.setTimeout(60_000)
    await insertInvoice(KIMI_USER, { amount: 179, status: "paid" })
    await openProfilePlan(user2Page)

    // El número de la factura sembrada aparece en el listado del perfil.
    await expect(user2Page.getByText("TEROS-SMOKE-0001", { exact: false })).toBeVisible({
      timeout: 15_000,
    })
  })

  test("downgrade programado: bajar de plan renderiza el pill scheduled-change y difiere el cambio", async ({
    user2Page,
  }) => {
    test.setTimeout(70_000)
    await openProfilePlan(user2Page)

    // Bajar de Pro (179) a Growth (89): un downgrade es DIFERIDO (F8) — el plan
    // activo NO cambia, se agenda scheduledPlanChange que el reset-cron aplicará al
    // vencer el periodo. Click en la PricingCard de Growth → confirmación inline.
    await user2Page.getByTestId("cta-plan_growth").click()
    await expect(user2Page.getByTestId("change-confirm")).toBeVisible({ timeout: 10_000 })
    await user2Page.getByTestId("change-confirm-apply").click()
    await expect(user2Page.getByTestId("toast-success").first()).toBeVisible({ timeout: 20_000 })

    // El pill "scheduled-change" aparece (la respuesta del change-plan trae
    // scheduledPlanChange → setSub lo refleja sin reload).
    await expect(user2Page.getByTestId("scheduled-change")).toBeVisible({ timeout: 10_000 })

    // Mongo crudo: sigue ACTIVO en Pro (downgrade diferido), con el cambio agendado a Growth.
    const sub = await getActiveSub(KIMI_USER)
    expect(sub?.planId, "el plan activo sigue siendo Pro (diferido)").toBe("plan_pro")
    expect(sub?.scheduledPlanChange?.planId, "el downgrade a Growth quedó agendado").toBe(
      "plan_growth",
    )
  })

  test("pill cancel-scheduled: se renderiza cuando la sub está marcada para cancelar al fin de periodo", async ({
    user2Page,
  }) => {
    test.setTimeout(60_000)
    // No hay UI self-serve de cancelación todavía (TER-601 diferido). Este test
    // verifica que el pill se renderiza a partir del estado de backend
    // (cancelAtPeriodEnd), que el reset-cron honra al vencer.
    await setCancelAtPeriodEnd(KIMI_USER, true)
    await openProfilePlan(user2Page)

    await expect(user2Page.getByTestId("cancel-scheduled")).toBeVisible({ timeout: 10_000 })
  })

  test("enlace de factura: abre la URL hospedada de Stripe y el target cumple ≥24px", async ({
    user2Page,
  }) => {
    test.setTimeout(60_000)
    // Factura con URL hospedada (insertInvoice ya pobla hostedInvoiceUrl).
    await insertInvoice(KIMI_USER, { amount: 179, status: "paid" })

    // RN-Web Linking.openURL → window.open(url,'_blank','noopener'). Lo interceptamos
    // en la página ya cargada (override en runtime, no initScript) para asertar el
    // destino SIN abrir una pestaña real.
    await user2Page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: window override
      ;(window as any).__opened = []
      window.open = ((url?: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: window override
        ;(window as any).__opened.push(String(url ?? ""))
        return null
      }) as typeof window.open
    })

    await openProfilePlan(user2Page)

    // Solo hay una factura (resetKimiBaseline borra las previas) → un único enlace "view".
    const viewLink = user2Page.locator('[data-testid^="invoice-view-"]').first()
    await expect(viewLink).toBeVisible({ timeout: 15_000 })
    // Target táctil ≥24px (WCAG 2.2 2.5.8; InvoiceLink minHeight:24).
    const box = await viewLink.boundingBox()
    expect(box?.height ?? 0, "target ≥24px de alto").toBeGreaterThanOrEqual(24)

    await viewLink.click()
    await expect
      .poll(
        // biome-ignore lint/suspicious/noExplicitAny: window global
        async () =>
          (await user2Page.evaluate(() => (window as any).__opened as string[])).join("|"),
        { timeout: 8000, message: "el enlace abre la URL hospedada de Stripe" },
      )
      .toContain("https://invoice.stripe.test/smoke")
  })
})
