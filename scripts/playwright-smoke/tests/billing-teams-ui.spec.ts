/**
 * T1 — Teams, DOM (TER-596 / TER-604). playwright3 (owner of team_demo) opens the
 * real Billing Teams window, drills into the team, edits its settings (seat price)
 * and adds a member through the rendered UI — asserting the raw Mongo effect. The
 * backend-contract spec (billing-teams) covers get-team-members shape; this is the
 * window the admin actually operates.
 *
 * Resets team_demo around each test so order doesn't matter.
 */

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import {
  getTeam,
  KIMI_USER,
  resetKimiBaseline,
  resetTeamBaseline,
  TEAM_ID,
} from "../helpers/billing"
import { closeDb } from "../helpers/db"
import { openViaNav } from "../helpers/dom"

/** nav → Billing Teams → open team_demo's detail. */
async function openTeamDetail(page: Page): Promise<void> {
  await openViaNav(page, "nav-billing-teams", "billing-teams-list")
  await page.getByTestId(`team-row-${TEAM_ID}`).click({ timeout: 10_000 })
  await page.getByTestId("billing-team-detail").waitFor({ state: "visible", timeout: 15_000 })
}

test.beforeEach(async () => {
  await resetTeamBaseline()
})
test.afterAll(async () => {
  await resetTeamBaseline()
  await resetKimiBaseline()
  await closeDb()
})

test.describe("billing — equipos T1 (DOM) @billing", () => {
  test("la lista de equipos abre el detalle del equipo", async ({ superPage }) => {
    test.setTimeout(60_000)
    await openViaNav(superPage, "nav-billing-teams", "billing-teams-list")
    await expect(superPage.getByTestId(`team-row-${TEAM_ID}`)).toBeVisible({ timeout: 10_000 })
    await superPage.getByTestId(`team-row-${TEAM_ID}`).click()
    await expect(superPage.getByTestId("billing-team-detail")).toBeVisible({ timeout: 15_000 })
    // Las cards de gestión están presentes.
    await expect(superPage.getByTestId("team-settings-card")).toBeVisible()
    await expect(superPage.getByTestId("team-members-card")).toBeVisible()
    await expect(superPage.getByTestId("company-settings-placeholder")).toBeVisible()
  })

  test("editar el precio por asiento y guardar persiste en Mongo", async ({ superPage }) => {
    test.setTimeout(60_000)
    await openTeamDetail(superPage)

    const seat = superPage.getByTestId("team-seat-price-input")
    await seat.fill("99")
    await superPage.getByTestId("team-save-btn").click()
    // Toast de éxito tras guardar.
    await expect(superPage.getByTestId("toast-success").first()).toBeVisible({ timeout: 15_000 })

    // Mongo: el override del precio por asiento quedó persistido.
    await expect
      .poll(async () => (await getTeam(TEAM_ID))?.customSeatPrice, {
        timeout: 10_000,
        message: "customSeatPrice persistido",
      })
      .toBe(99)
  })

  test("añadir un miembro lo persiste en el equipo", async ({ superPage }) => {
    test.setTimeout(60_000)
    await openTeamDetail(superPage)

    await superPage.getByTestId("team-add-member-input").fill(KIMI_USER)
    await superPage.getByTestId("team-add-member-btn").click()

    // La fila del miembro aparece en la card de miembros…
    await expect(superPage.getByTestId(`member-row-${KIMI_USER}`)).toBeVisible({ timeout: 15_000 })
    // …y Mongo lo refleja en memberIds.
    await expect
      .poll(async () => ((await getTeam(TEAM_ID))?.memberIds as string[]) ?? [], {
        timeout: 10_000,
        message: "el miembro entra en memberIds",
      })
      .toContain(KIMI_USER)
  })

  test("editar maxSeats + status y guardar persiste en Mongo", async ({ superPage }) => {
    test.setTimeout(60_000)
    await openTeamDetail(superPage)

    // maxSeats distinto del baseline (5) para que el campo MUERDA.
    await superPage.getByTestId("team-max-seats-input").fill("33")
    await superPage.getByTestId("team-status-paused").click()
    await superPage.getByTestId("team-save-btn").click()
    await expect(superPage.getByTestId("toast-success").first()).toBeVisible({ timeout: 15_000 })

    // Mongo: ambos campos persistidos por buildTeamSettingsPayload (solo cambiados).
    await expect
      .poll(async () => (await getTeam(TEAM_ID))?.maxSeats, {
        timeout: 10_000,
        message: "maxSeats persistido",
      })
      .toBe(33)
    expect((await getTeam(TEAM_ID))?.status, "status pasó a paused").toBe("paused")
  })

  test("buscar miembros filtra la lista renderizada", async ({ superPage }) => {
    test.setTimeout(60_000)
    await openTeamDetail(superPage)

    // Añadir un miembro para tener una fila que filtrar.
    await superPage.getByTestId("team-add-member-input").fill(KIMI_USER)
    await superPage.getByTestId("team-add-member-btn").click()
    await expect(superPage.getByTestId(`member-row-${KIMI_USER}`)).toBeVisible({ timeout: 15_000 })

    // Un query que NO casa (filterMembers por name/email/userId) oculta la fila…
    await superPage.getByTestId("team-member-search").fill("zzz-no-match")
    await expect(superPage.getByTestId(`member-row-${KIMI_USER}`)).toBeHidden({ timeout: 5000 })

    // …y un fragmento del userId la vuelve a mostrar.
    await superPage.getByTestId("team-member-search").fill(KIMI_USER.slice(5, 10))
    await expect(superPage.getByTestId(`member-row-${KIMI_USER}`)).toBeVisible({ timeout: 5000 })
  })

  test("quitar un miembro lo elimina del equipo", async ({ superPage }) => {
    test.setTimeout(60_000)
    await openTeamDetail(superPage)

    // Añadir y luego quitar por la UI — el callback onChanged refresca el roster.
    await superPage.getByTestId("team-add-member-input").fill(KIMI_USER)
    await superPage.getByTestId("team-add-member-btn").click()
    await expect(superPage.getByTestId(`member-row-${KIMI_USER}`)).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => ((await getTeam(TEAM_ID))?.memberIds as string[]) ?? [], {
        timeout: 10_000,
      })
      .toContain(KIMI_USER)

    await superPage.getByTestId(`member-remove-${KIMI_USER}`).click()

    // La fila desaparece…
    await expect(superPage.getByTestId(`member-row-${KIMI_USER}`)).toBeHidden({ timeout: 15_000 })
    // …y Mongo retira el miembro de memberIds.
    await expect
      .poll(async () => ((await getTeam(TEAM_ID))?.memberIds as string[]) ?? [], {
        timeout: 10_000,
        message: "el miembro sale de memberIds",
      })
      .not.toContain(KIMI_USER)
  })
})
