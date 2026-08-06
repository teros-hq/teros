/**
 * A1 — Admin individual (TER-596 / TER-603). The admin's Users/BillingPanel,
 * the Billing Requests queue and the audit window all read three admin actions:
 * `admin.list-access-requests` (enriched with the requester's live billing
 * context + estimated cost), `admin.get-billing-audit` (consumption/drift/ledger/
 * snapshots/invoices) and `admin.list-users` (the data behind the "Limit reached"
 * badge + plan picker). Driven by playwright1 (admin); the request is created by
 * playwright2's real client.
 */
import { closeDb } from "../helpers/db"
import { getActiveSub, KIMI_USER, resetKimiBaseline, setUsed } from "../helpers/billing"
import { attemptAction, wsRequest } from "../helpers/teros"
import { expect, test } from "../fixtures"

test.beforeEach(async () => {
  await resetKimiBaseline()
})
test.afterAll(async () => {
  await resetKimiBaseline()
  await closeDb()
})

test.describe("billing — admin individual A1 @billing", () => {
  test("list-access-requests enriquece la cola con plan/uso/%/coste estimado", async ({
    terosPage,
    user2Page,
  }) => {
    // El solicitante (playwright2) en plan_pro 70/80h crea una solicitud de boost.
    await setUsed(KIMI_USER, 70)
    const created = await wsRequest<{ request: { _id: string } }>(
      user2Page,
      "billing.request-access",
      { type: "boost", requestedHours: 20 },
    )
    expect(created.request._id, "solicitud creada").toBeTruthy()

    // El admin la ve enriquecida con el contexto de facturación del solicitante.
    const { requests } = await wsRequest<{
      requests: Array<{
        userId: string
        type: string
        requestedHours: number
        currentPlanName: string
        agentHoursUsed: number
        agentHoursLimit: number
        usagePct: number
        estimatedCost: number | null
        estimatedCostCurrency: string
      }>
    }>(terosPage, "admin.list-access-requests", { status: "pending" })

    const req = requests.find((r) => r.userId === KIMI_USER)
    expect(req, "la solicitud de playwright2 está en la cola").toBeTruthy()
    if (!req) return
    expect(req.type).toBe("boost")
    expect(req.requestedHours).toBe(20)
    expect(req.currentPlanName, "plan del solicitante").toBe("Pro")
    expect(req.agentHoursUsed).toBe(70)
    expect(req.agentHoursLimit).toBe(80)
    expect(req.usagePct, "round(70/80) = 88%").toBe(88)
    // Coste estimado = horas × precio del boost (20 × €3). Informativo (el grant no cobra).
    expect(req.estimatedCost).toBe(60)
    expect(req.estimatedCostCurrency).toBe("EUR")
  })

  test("get-billing-audit devuelve consumo/drift/snapshots/facturas", async ({ terosPage }) => {
    const audit = await wsRequest<{
      subscription: { agentHoursUsed: number } | null
      consumption: { expectedHours: number; actualHours: number; driftHours: number }
      snapshots: unknown[]
      invoices: unknown[]
    }>(terosPage, "admin.get-billing-audit", { userId: KIMI_USER })

    expect(audit.subscription, "sub resuelta").toBeTruthy()
    expect(audit.consumption, "bloque de consumo").toBeTruthy()
    // actual = agentHoursUsed (baseline 40); drift = |actual - expected| (number).
    expect(audit.consumption.actualHours).toBe(40)
    expect(typeof audit.consumption.expectedHours).toBe("number")
    expect(typeof audit.consumption.driftHours).toBe("number")
    expect(Array.isArray(audit.snapshots)).toBe(true)
    expect(Array.isArray(audit.invoices)).toBe(true)
  })

  test('badge "Limit reached": list-users muestra used >= limit al agotar', async ({
    terosPage,
  }) => {
    await setUsed(KIMI_USER, 80) // == límite de Pro
    const { users } = await wsRequest<{
      users: Array<{
        userId: string
        billing: { agentHoursUsed: number; effectiveLimit: number } | null
      }>
    }>(terosPage, "admin.list-users")
    const kimi = users.find((u) => u.userId === KIMI_USER)
    expect(kimi?.billing, "billing de playwright2").toBeTruthy()
    expect(
      (kimi?.billing?.agentHoursUsed ?? 0) >= (kimi?.billing?.effectiveLimit ?? Infinity),
      "used >= limit → badge Limit reached",
    ).toBe(true)
  })

  test("picker de plan usa el catálogo real: plan válido aplica, plan retirado → INVALID_PLAN", async ({
    terosPage,
  }) => {
    test.setTimeout(45_000) // el cambio inmediato puede tocar Stripe (best-effort)
    // Plan real del catálogo → aplica.
    await wsRequest(terosPage, "admin.update-billing-subscription", {
      targetUserId: KIMI_USER,
      planId: "plan_ultra",
    })
    expect((await getActiveSub(KIMI_USER))?.planId, "cambio a un plan real").toBe("plan_ultra")

    // Plan retirado por G0 (plan_basic) → rechazado, no aplica silenciosamente.
    const denied = await attemptAction(terosPage, "admin.update-billing-subscription", {
      targetUserId: KIMI_USER,
      planId: "plan_basic",
    })
    expect(denied.resolved, "un plan retirado no debe aplicar").toBe(false)
    expect(denied.code, "código de plan inválido").toBe("INVALID_PLAN")
  })
})
