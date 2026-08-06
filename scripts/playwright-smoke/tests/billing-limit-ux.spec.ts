/**
 * I4 — Limit UX (TER-596 / TER-602): boost pricing gate, self-serve purchase, the
 * team request path, and the 80% banner. Backend-contract through playwright2's
 * live client + raw Mongo, with one real DOM check for the banner→BoostModal flow.
 *
 * NOTE: the self-serve PURCHASE success path surfaced a real F4 charge bug —
 * `createInvoiceItem` left the item PENDING (unattached), so the Stripe invoice
 * finalized at €0, Stripe auto-paid it, and the explicit pay() threw "Invoice is
 * already paid" → the boost was never granted (confirmed against raw Stripe).
 * Fixed in this stack on fase4-stripe (create the invoice first, attach the item
 * with `invoice: created.id`); the purchase test below asserts the success path.
 */
import { closeDb } from "../helpers/db"
import {
  getAccessRequests,
  getBoosts,
  getInvoices,
  KIMI_USER,
  resetKimiBaseline,
  resetUserPlan,
  setSubTeam,
} from "../helpers/billing"
import { wsRequest } from "../helpers/teros"
import { expect, test } from "../fixtures"

interface GetSubResult {
  subscription: { planId: string; agentHoursLimit: number; boostHours: number; teamId: string | null } | null
  boostPricing: { hourPrice: number; currency: string } | null
}
interface BoostResult {
  boostId: string
  hours: number
  amount: number
  currency: string
  subscription: { agentHoursLimit: number; boostHours: number } | null
}

test.beforeEach(async () => {
  await resetKimiBaseline()
})
test.afterAll(async () => {
  await resetKimiBaseline()
  await closeDb()
})

test.describe("billing — UX de límite I4 @billing", () => {
  test("boostPricing: presente en plan metered (Pro), null en no-metered (Enterprise)", async ({
    user2Page,
  }) => {
    // Metered (plan_pro): el modal de compra se habilita con el precio configurado.
    const pro = await wsRequest<GetSubResult>(user2Page, "billing.get-subscription")
    expect(pro.boostPricing, "boostPricing en plan metered").toEqual({
      hourPrice: 3,
      currency: "EUR",
    })

    // No-metered (Enterprise, límite 0 = unmetered): null → modal "no disponible".
    await resetUserPlan(KIMI_USER, "plan_enterprise")
    const ent = await wsRequest<GetSubResult>(user2Page, "billing.get-subscription")
    expect(ent.boostPricing, "boostPricing null en plan no-metered").toBeNull()
  })

  test("purchase-boost compra horas: cobra la tarjeta + concede el boost + sube el límite", async ({
    user2Page,
  }) => {
    // Regresión F4 (arreglada en fase4-stripe): el cobro creaba el invoice item sin
    // adjuntarlo → factura €0 → "already paid" → el boost no se concedía. Tras el fix
    // la compra cobra la tarjeta y concede el boost.
    test.setTimeout(45_000)
    const reqId = `smoke-buy-${Date.now()}`
    const res = await wsRequest<BoostResult>(user2Page, "billing.purchase-boost", {
      hours: 10,
      reqId,
    })
    // 10h × €3 = €30 cargados; boost activo concedido.
    expect(res.hours).toBe(10)
    expect(res.amount).toBe(30)
    expect(res.currency).toBe("EUR")
    expect(res.boostId).toBeTruthy()

    // Mongo: un boost activo + una factura pagada.
    const boosts = await getBoosts(KIMI_USER)
    expect(boosts.length, "un boost concedido").toBe(1)
    expect(boosts[0]?.hours).toBe(10)
    expect(boosts[0]?.status).toBe("active")
    const invs = await getInvoices(KIMI_USER)
    expect(invs.some((i) => i.status === "paid" && i.amount === 30), "factura pagada €30").toBe(true)

    // Límite efectivo subido (80 base + 10 boost).
    const after = await wsRequest<GetSubResult>(user2Page, "billing.get-subscription")
    expect(after.subscription?.agentHoursLimit, "límite con boost").toBe(90)
    expect(after.subscription?.boostHours).toBe(10)

    // Idempotencia: mismo reqId → mismo boost, sin doble cargo.
    const again = await wsRequest<BoostResult>(user2Page, "billing.purchase-boost", {
      hours: 10,
      reqId,
    })
    expect(again.boostId, "idempotente por reqId").toBe(res.boostId)
    expect((await getBoosts(KIMI_USER)).length, "sigue habiendo un solo boost").toBe(1)
  })

  test("request-access (modo equipo): crea una solicitud pendiente sin cobrar", async ({
    user2Page,
  }) => {
    // Miembro de equipo → el modal pide al admin en vez de comprar.
    await setSubTeam(KIMI_USER, "team_demo")
    const sub = await wsRequest<GetSubResult>(user2Page, "billing.get-subscription")
    expect(sub.subscription?.teamId, "el modal entra en modo equipo").toBe("team_demo")

    const r = await wsRequest<{
      request: { type: string; requestedHours: number; reason: string | null; status: string }
    }>(user2Page, "billing.request-access", {
      type: "boost",
      requestedHours: 5,
      reason: "necesito más horas",
    })
    expect(r.request.type).toBe("boost")
    expect(r.request.requestedHours).toBe(5)
    expect(r.request.status).toBe("pending")

    // Mongo: solicitud pendiente, sin boost ni factura (es solicitud, no compra).
    const reqs = await getAccessRequests(KIMI_USER)
    expect(reqs.length, "una solicitud").toBe(1)
    expect(reqs[0]?.status).toBe("pending")
    expect(reqs[0]?.requestedHours).toBe(5)
    expect((await getBoosts(KIMI_USER)).length, "no concede horas todavía").toBe(0)
  })

  test("banner 80%: se muestra con el evento usage-warning y su CTA abre el BoostModal", async ({
    user2Page,
  }) => {
    // El backend emite `billing.usage-warning` al cruzar el 80%; lo forzamos para
    // probar el render del banner + que su CTA abre el modal de boost.
    await user2Page.evaluate(() => {
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

    await expect(user2Page.getByTestId("billing-warning-banner")).toBeVisible()
    await expect(user2Page.getByTestId("billing-warning-usage")).toContainText("64.0h / 80h")

    // CTA → BoostModal (modo compra individual: plan_pro con boostPricing, sin equipo).
    await user2Page.getByTestId("billing-warning-cta").click()
    await expect(user2Page.getByTestId("boost-panel")).toBeVisible()
    await expect(user2Page.getByTestId("boost-buy")).toBeVisible({ timeout: 10_000 })
    // El total refleja el precio real (10h × €3).
    await expect(user2Page.getByTestId("boost-total")).toContainText("30")
  })
})
