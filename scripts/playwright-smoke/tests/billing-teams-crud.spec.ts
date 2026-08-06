/**
 * T1 — Team CRUD by contract (TER-596 / TER-604). `admin.create-billing-team` and
 * `admin.delete-billing-team` have NO UI in the BillingTeamsWindow (the window
 * lists + edits existing teams; creation/deletion is admin-by-API), so they're
 * covered here at the WS-contract layer: create → it shows up in list-billing-teams
 * + Mongo → delete → it's gone. Plus the negative authz: a non-admin (playwright2)
 * is denied both, and team_demo is never touched.
 *
 * Uses a dedicated throwaway team (team_smoke-crud) so the documented baseline
 * (team_demo) stays pristine. beforeEach/afterAll best-effort delete it.
 */
import { expect, test } from "../fixtures"
import { deleteTeam, getTeam, TEAM_ID } from "../helpers/billing"
import { closeDb } from "../helpers/db"
import { attemptAction, wsRequest } from "../helpers/teros"

const CRUD_SLUG = "smoke-crud"
const CRUD_TEAM_ID = `team_${CRUD_SLUG}`

interface CreatedTeam {
  team: { _id: string; slug: string; planId: string; seatCount: number; maxSeats: number }
}
interface TeamsList {
  teams: Array<{ _id: string }>
}

/** Best-effort teardown so a prior run's leftover never trips DUPLICATE_SLUG. */
async function dropCrudTeam(page: import("@playwright/test").Page): Promise<void> {
  await attemptAction(page, "admin.delete-billing-team", { teamId: CRUD_TEAM_ID })
}

test.beforeEach(async ({ terosPage }) => {
  await dropCrudTeam(terosPage)
})
test.afterAll(async () => {
  // afterAll can't use test-scoped page fixtures → clean up via Mongo directly.
  await deleteTeam(CRUD_TEAM_ID)
  await closeDb()
})

test.describe("billing — CRUD de equipos por contrato T1 @billing", () => {
  test("crear un equipo lo añade al listado + Mongo; borrarlo lo elimina", async ({
    terosPage,
  }) => {
    test.setTimeout(60_000)

    // CREATE — el admin crea el equipo (id derivado del slug: team_smoke-crud).
    const created = await wsRequest<CreatedTeam>(terosPage, "admin.create-billing-team", {
      name: "Smoke CRUD",
      slug: CRUD_SLUG,
      planId: "plan_pro",
      maxSeats: 3,
    })
    expect(created.team._id, "id derivado del slug").toBe(CRUD_TEAM_ID)
    expect(created.team.planId).toBe("plan_pro")
    expect(created.team.seatCount, "sin miembros al crear").toBe(0)
    expect(created.team.maxSeats).toBe(3)

    // LIST — aparece en el listado que consume la ventana de equipos.
    const list1 = await wsRequest<TeamsList>(terosPage, "admin.list-billing-teams", {})
    expect(
      list1.teams.some((t) => t._id === CRUD_TEAM_ID),
      "el equipo creado está en list-billing-teams",
    ).toBe(true)
    // Mongo crudo: el equipo existe.
    expect(await getTeam(CRUD_TEAM_ID), "el equipo existe en Mongo").toBeTruthy()

    // DELETE — sin miembros, el borrado procede.
    const del = await wsRequest<{ deleted: boolean }>(terosPage, "admin.delete-billing-team", {
      teamId: CRUD_TEAM_ID,
    })
    expect(del.deleted).toBe(true)

    // LIST — ya no aparece. Mongo crudo: se eliminó.
    const list2 = await wsRequest<TeamsList>(terosPage, "admin.list-billing-teams", {})
    expect(
      list2.teams.some((t) => t._id === CRUD_TEAM_ID),
      "el equipo borrado desaparece del listado",
    ).toBe(false)
    expect(await getTeam(CRUD_TEAM_ID), "el equipo ya no existe en Mongo").toBeNull()
  })

  test("authz: un no-admin no puede crear ni borrar equipos", async ({ user2Page }) => {
    test.setTimeout(60_000)

    // CREATE como no-admin (playwright2, role 'user') → FORBIDDEN, sin crear nada.
    const createAttempt = await attemptAction(user2Page, "admin.create-billing-team", {
      name: "Hacker Team",
      slug: "hacker-team",
      planId: "plan_pro",
      maxSeats: 1,
    })
    expect(createAttempt.resolved, "el create de un no-admin es denegado").toBe(false)
    expect(createAttempt.code).toBe("FORBIDDEN")
    expect(await getTeam("team_hacker-team"), "no se creó ningún equipo").toBeNull()

    // DELETE de un equipo real (team_demo) como no-admin → FORBIDDEN, sin tocarlo.
    const deleteAttempt = await attemptAction(user2Page, "admin.delete-billing-team", {
      teamId: TEAM_ID,
    })
    expect(deleteAttempt.resolved, "el delete de un no-admin es denegado").toBe(false)
    expect(deleteAttempt.code).toBe("FORBIDDEN")
    expect(await getTeam(TEAM_ID), "team_demo sigue existiendo").toBeTruthy()
  })
})
