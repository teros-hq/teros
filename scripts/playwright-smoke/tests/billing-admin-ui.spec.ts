/**
 * A1 — Admin individual, DOM (TER-596 / TER-603). playwright3 (admin) opens the
 * real Users window, opens playwright2's detail → Billing tab, and from it: launches
 * the audit window, sees the "Limit reached" badge, and checks the plan picker
 * lists the REAL catalogue (the G0 regression: retired plan_basic must be gone).
 * A final cross-user test approves a request from the Billing Requests window and
 * asserts the requester (playwright2) gets the realtime success toast.
 *
 * Resets playwright2 + team_demo around each test so order doesn't matter.
 */

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import {
  getAccessRequests,
  KIMI_USER,
  resetKimiBaseline,
  resetTeamBaseline,
  setSubTeam,
  setUsed,
} from "../helpers/billing"
import { closeDb } from "../helpers/db"
import { expectToast, openViaNav } from "../helpers/dom"
import { wsRequest } from "../helpers/teros"

const PW2_EMAIL = "playwright2@test.com"

/**
 * Opens the Users window → playwright2's detail → its Billing tab (the old inline
 * BillingPanel became the detail view's "Facturación" tab in c8353e213, TER-685).
 */
async function openUsersBillingPw2(page: Page): Promise<void> {
  await page.getByTestId("nav-users").click({ timeout: 10_000 })
  const row = page.getByText(PW2_EMAIL, { exact: false }).first()
  await row.waitFor({ state: "visible", timeout: 15_000 })
  await row.click()
  await page.getByTestId("user-detail-view").waitFor({ state: "visible", timeout: 15_000 })
  await page.getByRole("tab", { name: /Billing|Facturación|청구/ }).click()
  await page.getByTestId("billing-summary").first().waitFor({ state: "visible", timeout: 15_000 })
}

test.beforeEach(async () => {
  await resetKimiBaseline()
})
test.afterAll(async () => {
  await resetKimiBaseline()
  await resetTeamBaseline()
  await closeDb()
})

test.describe("billing — admin individual A1 (DOM) @billing", () => {
  test('"View audit" abre la ventana de auditoría de billing', async ({ superPage }) => {
    test.setTimeout(60_000)
    await openUsersBillingPw2(superPage)

    await superPage.getByTestId("billing-audit-btn").first().click()
    await expect(superPage.getByTestId("billing-audit-window")).toBeVisible({ timeout: 15_000 })
  })

  test('el badge "Limit reached" aparece al 100% del límite', async ({ superPage }) => {
    test.setTimeout(60_000)
    await setUsed(KIMI_USER, 80) // Pro = 80h → usado >= límite
    // La Users window puede estar ya abierta (tiling restaurado) con datos viejos;
    // clicar el nav solo la enfoca, no re-fetch. Un reload la re-monta → re-fetch
    // con el uso actualizado (80/80).
    await superPage.reload({ waitUntil: "networkidle" })
    await superPage.waitForTimeout(2000)
    await openUsersBillingPw2(superPage)

    await expect(superPage.getByTestId("billing-limit-badge")).toBeVisible({ timeout: 10_000 })
  })

  test("el picker de plan lista el catálogo real (sin el plan_basic retirado)", async ({
    superPage,
  }) => {
    test.setTimeout(60_000)
    await openUsersBillingPw2(superPage)
    // Entrar en modo edición revela el picker de plan (chips del catálogo).
    await superPage.getByTestId("billing-edit-btn").first().click()
    // Catálogo real (G0): Starter/Ultra/Enterprise presentes…
    await expect(superPage.getByTestId("billing-plan-plan_starter")).toBeVisible({
      timeout: 10_000,
    })
    await expect(superPage.getByTestId("billing-plan-plan_ultra")).toBeVisible()
    await expect(superPage.getByTestId("billing-plan-plan_enterprise")).toBeVisible()
    // …y el plan retirado por G0 NO aparece (regresión INVALID_PLAN arreglada).
    await expect(superPage.getByTestId("billing-plan-plan_basic")).toHaveCount(0)
  })

  test("aprobar una solicitud desde la cola → el solicitante recibe un toast", async ({
    superPage,
    user2Page,
  }) => {
    test.setTimeout(70_000)
    // playwright2 (en equipo) crea una solicitud de boost.
    await setSubTeam(KIMI_USER, "team_demo")
    await wsRequest(user2Page, "billing.request-access", {
      type: "boost",
      requestedHours: 5,
      reason: "smoke approve",
    })
    const reqs = await getAccessRequests(KIMI_USER)
    expect(reqs.length, "la solicitud existe").toBe(1)
    const reqId = reqs[0]?._id as string

    // El admin abre la cola y aprueba la solicitud (botón a la derecha). El toast del
    // solicitante dura ~3s, así que NO metemos esperas previas: expect (auto-polling)
    // arranca justo tras el click y caza el toast en su ventana de vida.
    await openViaNav(superPage, "nav-billing-requests", `billing-req-${reqId}`)
    await superPage.getByTestId(`billing-req-${reqId}-approve`).click()

    // El solicitante (playwright2), en su sesión, recibe el toast de éxito en vivo.
    await expectToast(user2Page, "success", 12_000)

    // Mongo: la solicitud quedó resuelta.
    await expect
      .poll(async () => (await getAccessRequests(KIMI_USER))[0]?.status, {
        timeout: 10_000,
        message: "la solicitud pasa a resuelta",
      })
      .not.toBe("pending")
  })

  test("denegar una solicitud desde la cola → el solicitante recibe un toast de aviso", async ({
    superPage,
    user2Page,
  }) => {
    test.setTimeout(70_000)
    // Gemelo del approve: blinda la OTRA rama del fix de pubsub (access-denied).
    await setSubTeam(KIMI_USER, "team_demo")
    await wsRequest(user2Page, "billing.request-access", {
      type: "boost",
      requestedHours: 5,
      reason: "smoke deny",
    })
    const reqs = await getAccessRequests(KIMI_USER)
    expect(reqs.length, "la solicitud existe").toBe(1)
    const reqId = reqs[0]?._id as string

    await openViaNav(superPage, "nav-billing-requests", `billing-req-${reqId}`)
    await superPage.getByTestId(`billing-req-${reqId}-deny`).click()

    // El solicitante recibe el toast de aviso (warning) en vivo.
    await expectToast(user2Page, "warning", 12_000)

    // Mongo: la solicitud quedó denegada.
    await expect
      .poll(async () => (await getAccessRequests(KIMI_USER))[0]?.status, {
        timeout: 10_000,
        message: "la solicitud pasa a denied",
      })
      .toBe("denied")
  })
})
