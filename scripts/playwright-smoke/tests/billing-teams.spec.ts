/**
 * T1 — Teams (TER-596 / TER-604). The BillingTeamsWindow reads `admin.get-team-
 * members` (roster + owner) and mutates via `admin.update-billing-team` (members,
 * plan, seat-price override). And request-access from a team member must route the
 * live push ONLY to the team owner, never to the requester (decision T1). Driven by
 * playwright1 (admin + owner of team_demo); the request comes from playwright2.
 */
import { closeDb } from "../helpers/db"
import {
  ADMIN_USER,
  getTeam,
  KIMI_USER,
  resetKimiBaseline,
  resetTeamBaseline,
  setSubTeam,
  setUsed,
  TEAM_ID,
} from "../helpers/billing"
import { wsRequest } from "../helpers/teros"
import { expect, test } from "../fixtures"
import type { Page } from "@playwright/test"

interface TeamView {
  team: { planId: string; seatPrice: number; customSeatPrice: number | null; seatCount: number }
  owner: { userId: string } | null
  members: Array<{
    userId: string
    isOwner: boolean
    planId: string
    agentHoursUsed: number | null
    agentHoursLimit: number | null
    usagePct: number | null
  }>
}

/** Install a one-shot capture for a client event on a page (before the trigger). */
async function captureEvent(page: Page, event: string): Promise<void> {
  await page.evaluate((ev) => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    const w = window as any
    w.__captured = w.__captured || {}
    w.__captured[ev] = null
    w.teros.on(ev, (d: unknown) => {
      w.__captured[ev] = d ?? "received"
    })
  }, event)
}
async function readCaptured(page: Page, event: string): Promise<unknown> {
  return page.evaluate((ev) => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    return (window as any).__captured?.[ev] ?? null
  }, event)
}

test.beforeEach(async () => {
  await resetTeamBaseline()
  await resetKimiBaseline()
})
test.afterAll(async () => {
  await resetTeamBaseline()
  await resetKimiBaseline()
  await closeDb()
})

test.describe("billing — equipos T1 @billing", () => {
  test("get-team-members resuelve el roster (miembro con plan/uso + owner)", async ({
    terosPage,
  }) => {
    // Añadir playwright2 al equipo (mete su sub en el team + suma asiento).
    await wsRequest(terosPage, "admin.update-billing-team", {
      teamId: TEAM_ID,
      addMemberIds: [KIMI_USER],
    })

    const view = await wsRequest<TeamView>(terosPage, "admin.get-team-members", { teamId: TEAM_ID })
    expect(view.owner?.userId, "owner resuelto").toBe(ADMIN_USER)
    expect(view.team.seatCount, "un asiento ocupado").toBe(1)

    const member = view.members.find((m) => m.userId === KIMI_USER)
    expect(member, "playwright2 aparece en el roster").toBeTruthy()
    if (!member) return
    expect(member.isOwner).toBe(false)
    expect(member.planId).toBe("plan_pro")
    expect(member.agentHoursUsed).toBe(40)
    expect(member.agentHoursLimit).toBe(80)
    expect(member.usagePct, "round(40/80) = 50%").toBe(50)
  })

  test("update-billing-team: override de seat-price aplica, sobrevive al cambio de plan, y se limpia", async ({
    terosPage,
  }) => {
    // Override manual (decisión E/F11): seatPrice = customSeatPrice.
    const r1 = await wsRequest<{ team: TeamView["team"] }>(
      terosPage,
      "admin.update-billing-team",
      { teamId: TEAM_ID, customSeatPrice: 75 },
    )
    expect(r1.team.customSeatPrice).toBe(75)
    expect(r1.team.seatPrice, "seatPrice = override").toBe(75)

    // Cambiar el plan PRESERVA el override (antes lo pisaba con plan.price).
    const r2 = await wsRequest<{ team: TeamView["team"] }>(
      terosPage,
      "admin.update-billing-team",
      { teamId: TEAM_ID, planId: "plan_ultra" },
    )
    expect(r2.team.planId).toBe("plan_ultra")
    expect(r2.team.seatPrice, "override preservado al cambiar de plan").toBe(75)
    expect(r2.team.customSeatPrice).toBe(75)

    // Limpiar el override → vuelve al precio del plan (Ultra = 349).
    const r3 = await wsRequest<{ team: TeamView["team"] }>(
      terosPage,
      "admin.update-billing-team",
      { teamId: TEAM_ID, customSeatPrice: null },
    )
    expect(r3.team.customSeatPrice).toBeNull()
    expect(r3.team.seatPrice, "vuelve al precio del plan").toBe(349)

    // Confirmar contra Mongo crudo.
    const raw = (await getTeam(TEAM_ID)) as { seatPrice: number; customSeatPrice: number | null }
    expect(raw.seatPrice).toBe(349)
    expect(raw.customSeatPrice).toBeNull()
  })

  test("routing al owner: la solicitud de un miembro llega SOLO al owner, no al solicitante", async ({
    terosPage,
    user2Page,
  }) => {
    // Regresión F6a+F6b (arreglada en este stack): el realtime de billing estaba
    // muerto end-to-end — el dominio billing no recibía pubSubService (no difundía,
    // F6a) y el cliente no forwardeaba billing.* al eventBus (F6b). Tras los dos
    // fixes, el owner recibe el push y el solicitante no se auto-notifica.
    // playwright2 es miembro del equipo (sub.teamId) y está al límite.
    await setSubTeam(KIMI_USER, TEAM_ID)
    await setUsed(KIMI_USER, 80)

    // Interceptar el push en AMBAS sesiones ANTES del trigger (cross-user realtime).
    await captureEvent(terosPage, "billing.access-requested") // owner (playwright1)
    await captureEvent(user2Page, "billing.access-requested") // requester (playwright2)

    // El miembro solicita horas al admin.
    await wsRequest(user2Page, "billing.request-access", { type: "boost", requestedHours: 5 })

    // El owner recibe el push en vivo…
    let ownerGot: unknown = null
    for (let i = 0; i < 20 && !ownerGot; i++) {
      ownerGot = await readCaptured(terosPage, "billing.access-requested")
      if (!ownerGot) await terosPage.waitForTimeout(300)
    }
    expect(ownerGot, "el owner recibe el push billing.access-requested").toBeTruthy()

    // …y el solicitante NUNCA se auto-notifica.
    const requesterGot = await readCaptured(user2Page, "billing.access-requested")
    expect(requesterGot, "el solicitante no se auto-notifica").toBeNull()
  })
})
