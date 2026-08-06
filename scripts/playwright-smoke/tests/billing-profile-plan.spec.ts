/**
 * I3 — Profile → Plan (TER-596 / TER-600). The data that drives UsageHero, the
 * side-by-side PricingCards, the PaymentMethodCard and the change-plan preview all
 * comes from `billing.get-subscription` / `billing.preview-plan-change` /
 * `billing.change-plan` / `billing.get-invoices`. We drive them through
 * playwright2's live client (the user that owns a real subscription) and assert
 * the RAW Mongo result, so the F8 upgrade/downgrade semantics are checked against
 * the real handler, not a mock.
 *
 * Each test rebaselines playwright2 to plan_pro 40/80h first, so they're order-
 * independent; afterAll restores the documented baseline for Antonio's smoke.
 */
import { closeDb } from "../helpers/db"
import {
  getActiveSub,
  getAllSubs,
  insertInvoice,
  KIMI_USER,
  resetKimiBaseline,
} from "../helpers/billing"
import { wsRequest } from "../helpers/teros"
import { expect, test } from "../fixtures"

interface SubView {
  planId: string
  planName: string
  agentHoursUsed: number
  agentHoursLimit: number
  boostHours: number
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
  scheduledPlanChange: { planId: string; planName: string; scheduledAt: string } | null
  teamId: string | null
}
interface GetSubResult {
  subscription: SubView | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  boostPricing: { hourPrice: number; currency: string } | null
}
interface Preview {
  kind: "upgrade" | "downgrade"
  prorationAmount: number
  currency: string
  newPrice: number
  currentPlanName: string
  newPlanName: string
  effectiveDate: string
}

test.beforeEach(async () => {
  await resetKimiBaseline()
})
test.afterAll(async () => {
  await resetKimiBaseline()
  await closeDb()
})

test.describe("billing — perfil → plan I3 @billing", () => {
  test("get-subscription expone UsageHero + PricingCards + tarjeta + boostPricing", async ({
    user2Page,
  }) => {
    const r = await wsRequest<GetSubResult>(user2Page, "billing.get-subscription")
    const s = r.subscription
    expect(s, "suscripción activa").toBeTruthy()
    if (!s) return
    expect(s.planId).toBe("plan_pro")
    expect(s.planName, "displayName para el header").toBe("Pro")
    expect(s.agentHoursUsed).toBe(40)
    expect(s.agentHoursLimit, "límite efectivo (base 80, sin boosts)").toBe(80)
    expect(s.boostHours).toBe(0)
    expect(s.status).toBe("active")
    expect(s.scheduledPlanChange, "sin cambio programado en baseline").toBeNull()
    expect(s.teamId, "sin equipo en baseline").toBeNull()
    // currentPeriodEnd alimenta "días al reset" del UsageHero.
    expect(Number.isNaN(Date.parse(s.currentPeriodEnd)), "currentPeriodEnd ISO").toBe(false)

    // boostPricing no-null en plan metered (plan_pro) — habilita el modal de compra.
    expect(r.boostPricing, "boostPricing en plan metered").toEqual({ hourPrice: 3, currency: "EUR" })

    // PaymentMethodCard: tarjeta vaulteada (Visa ···· NNNN).
    expect(r.paymentMethod, "tarjeta por defecto").toBeTruthy()
    expect((r.paymentMethod?.last4 ?? "").length, "last4 de 4 dígitos").toBe(4)
    expect(r.paymentMethod?.brand, "marca de la tarjeta").toBeTruthy()
  })

  test("preview-plan-change: upgrade cobra prorrateado (>0), downgrade es diferido y €0", async ({
    user2Page,
  }) => {
    const sub = (await wsRequest<GetSubResult>(user2Page, "billing.get-subscription")).subscription
    expect(sub).toBeTruthy()

    // Upgrade pro→ultra: cargo prorrateado real, estrictamente entre 0 y la
    // diferencia completa (349-179=170) porque estamos a mitad de periodo.
    const up = await wsRequest<Preview>(user2Page, "billing.preview-plan-change", {
      planId: "plan_ultra",
    })
    expect(up.kind).toBe("upgrade")
    expect(up.newPrice).toBe(349)
    expect(up.currentPlanName).toBe("Pro")
    expect(up.newPlanName).toBe("Ultra")
    expect(up.prorationAmount, "proration > 0").toBeGreaterThan(0)
    expect(up.prorationAmount, "proration < diferencia completa (mitad de periodo)").toBeLessThan(
      170,
    )

    // Downgrade pro→growth: diferido al fin de periodo, sin cargo.
    const down = await wsRequest<Preview>(user2Page, "billing.preview-plan-change", {
      planId: "plan_growth",
    })
    expect(down.kind).toBe("downgrade")
    expect(down.prorationAmount, "downgrade no cobra").toBe(0)
    expect(down.newPrice).toBe(89)
    expect(
      Math.abs(Date.parse(down.effectiveDate) - Date.parse(sub?.currentPeriodEnd ?? "")),
      "downgrade efectivo al fin de periodo (currentPeriodEnd)",
    ).toBeLessThan(1000)
  })

  test("change-plan upgrade aplica F8: horas completas + corte preservado + sub vieja ended", async ({
    user2Page,
  }) => {
    test.setTimeout(50_000) // el cargo de proración llama a Stripe (best-effort)
    const before = await getActiveSub(KIMI_USER)
    const originalEnd = before?.currentPeriodEnd?.getTime() ?? 0
    expect(before?.planId).toBe("plan_pro")

    const res = await wsRequest<{ kind: string; subscription: SubView | null }>(
      user2Page,
      "billing.change-plan",
      { planId: "plan_ultra" },
    )
    expect(res.kind, "upgrade inmediato").toBe("upgraded")

    // Mongo crudo: NUEVA sub activa en ultra, horas COMPLETAS (reset a 0), corte
    // ORIGINAL preservado; la sub pro vieja queda 'ended'.
    const active = await getActiveSub(KIMI_USER)
    expect(active?.planId, "ahora plan_ultra activo").toBe("plan_ultra")
    expect(active?.agentHoursUsed, "horas completas: reset a 0").toBe(0)
    expect(
      Math.abs((active?.currentPeriodEnd?.getTime() ?? 0) - originalEnd),
      "corte original preservado",
    ).toBeLessThan(2000)

    const all = await getAllSubs(KIMI_USER)
    const oldPro = all.find((x) => x._id === before?._id)
    expect(oldPro?.status, "la sub pro vieja queda ended").toBe("ended")

    // get-subscription refleja el límite del plan nuevo (200h).
    const view = (await wsRequest<GetSubResult>(user2Page, "billing.get-subscription")).subscription
    expect(view?.agentHoursLimit, "límite de ultra").toBe(200)
  })

  test("change-plan downgrade es diferido: sigue en pro + scheduledPlanChange", async ({
    user2Page,
  }) => {
    const res = await wsRequest<{ kind: string; subscription: SubView | null }>(
      user2Page,
      "billing.change-plan",
      { planId: "plan_growth" },
    )
    expect(res.kind, "downgrade diferido, no inmediato").toBe("downgrade_scheduled")

    // Mongo: la sub activa SIGUE en pro; el cambio queda programado, no aplicado.
    const active = await getActiveSub(KIMI_USER)
    expect(active?.planId, "sigue en pro hasta fin de periodo").toBe("plan_pro")
    expect(active?.scheduledPlanChange?.planId, "downgrade programado a growth").toBe("plan_growth")
  })

  test("get-invoices surface el historial con sus enlaces (hosted + pdf)", async ({
    user2Page,
  }) => {
    const id = await insertInvoice(KIMI_USER, { amount: 123, status: "paid" })
    const { invoices } = await wsRequest<{ invoices: Record<string, unknown>[] }>(
      user2Page,
      "billing.get-invoices",
    )
    const inv = invoices.find((i) => i.id === id)
    expect(inv, "la factura sembrada aparece en get-invoices").toBeTruthy()
    if (!inv) return
    expect(inv.amount).toBe(123)
    expect(inv.currency).toBe("EUR")
    expect(inv.status).toBe("paid")
    expect(inv.invoiceNumber).toBe("TEROS-SMOKE-0001")
    // Los enlaces a la factura Stripe — lo que el InvoiceRow enlaza (≥24px target).
    expect(inv.hostedInvoiceUrl, "enlace hosted").toBe("https://invoice.stripe.test/smoke")
    expect(inv.invoicePdfUrl, "enlace pdf").toBe("https://invoice.stripe.test/smoke.pdf")
  })
})
