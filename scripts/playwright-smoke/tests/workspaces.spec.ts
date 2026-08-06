/**
 * Workspaces domain — create/update/archive via window.teros + realtime fan-out to
 * a second session of the same user. listWorkspaces() returns only active ones, so
 * archive ⇒ absence is the assertion.
 */
import { capturedErrors, expect, test } from "../fixtures"
import { clearEvents, evalTeros, waitForEvent } from "../helpers/teros"

test.describe("workspaces @workspaces", () => {
  test("create → update → archive vía window.teros", async ({ terosPage }) => {
    const name = `Pw WS ${Date.now()}`

    const workspaceId = await evalTeros(
      terosPage,
      (name) =>
        window.teros.workspace.createWorkspace({ name }).then((r) => r.workspace.workspaceId),
      name,
    )
    expect(workspaceId, "createWorkspace devuelve workspaceId").toBeTruthy()

    const present = await evalTeros(
      terosPage,
      (id) => window.teros.listWorkspaces().then((wss) => wss.some((w) => w.workspaceId === id)),
      workspaceId,
    )
    expect(present, "workspace presente en listWorkspaces tras create").toBe(true)

    // update
    const newName = `${name} renamed`
    await evalTeros(
      terosPage,
      ({ id, newName }) =>
        window.teros.workspace.updateWorkspace({ workspaceId: id, name: newName }).then(() => null),
      { id: workspaceId, newName },
    )
    const renamed = await evalTeros(
      terosPage,
      ({ id, newName }) =>
        window.teros
          .listWorkspaces()
          .then((wss) => wss.find((w) => w.workspaceId === id)?.name === newName),
      { id: workspaceId, newName },
    )
    expect(renamed, "nombre del workspace actualizado").toBe(true)

    // archive → gone from the active list
    await evalTeros(
      terosPage,
      (id) => window.teros.workspace.archiveWorkspace(id).then(() => null),
      workspaceId,
    )
    const gone = await evalTeros(
      terosPage,
      (id) => window.teros.listWorkspaces().then((wss) => !wss.some((w) => w.workspaceId === id)),
      workspaceId,
    )
    expect(gone, "workspace archivado fuera de la lista activa").toBe(true)

    const errs = capturedErrors(terosPage)
    if (errs.network.length)
      console.log(`⚠️  network 4xx/5xx: ${[...new Set(errs.network)].join(", ")}`)
    expect(errs.console, errs.console.join("\n")).toEqual([])
    expect(errs.page, errs.page.join("\n")).toEqual([])
  })

  test("create/update/archive propagan en realtime a una 2ª sesión @realtime", async ({
    terosPage,
    secondUser1Page,
  }) => {
    const name = `Pw RT WS ${Date.now()}`

    // CREATE
    await clearEvents(secondUser1Page)
    const workspaceId = await evalTeros(
      terosPage,
      (name) =>
        window.teros.workspace.createWorkspace({ name }).then((r) => r.workspace.workspaceId),
      name,
    )
    expect(
      await waitForEvent(secondUser1Page, { type: "workspace.created" }, 8000),
      "evento workspace.created en la 2ª sesión",
    ).toBeTruthy()
    const seenB = await evalTeros(
      secondUser1Page,
      (id) => window.teros.listWorkspaces().then((wss) => wss.some((w) => w.workspaceId === id)),
      workspaceId,
    )
    expect(seenB, "la 2ª sesión ve el workspace nuevo").toBe(true)

    // UPDATE
    await clearEvents(secondUser1Page)
    await evalTeros(
      terosPage,
      ({ id, name }) =>
        window.teros.workspace
          .updateWorkspace({ workspaceId: id, name: `${name} v2` })
          .then(() => null),
      { id: workspaceId, name },
    )
    expect(
      await waitForEvent(secondUser1Page, { type: "workspace.updated" }, 8000),
      "evento workspace.updated recibido",
    ).toBeTruthy()

    // ARCHIVE
    await clearEvents(secondUser1Page)
    await evalTeros(
      terosPage,
      (id) => window.teros.workspace.archiveWorkspace(id).then(() => null),
      workspaceId,
    )
    expect(
      await waitForEvent(secondUser1Page, { type: "workspace.archived" }, 8000),
      "evento workspace.archived recibido",
    ).toBeTruthy()
    const goneB = await evalTeros(
      secondUser1Page,
      (id) => window.teros.listWorkspaces().then((wss) => !wss.some((w) => w.workspaceId === id)),
      workspaceId,
    )
    expect(goneB, "la 2ª sesión ya no ve el workspace archivado").toBe(true)
  })
})
