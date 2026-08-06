/**
 * Agents domain — CRUD via window.teros + realtime fan-out to a second session.
 * State assertions go through the live client (listAgents), never the DOM.
 */
import { capturedErrors, expect, test } from "../fixtures"
import { clearEvents, evalTeros, getPrimaryIds, waitForEvent } from "../helpers/teros"

test.describe("agents @agents", () => {
  test("ciclo CRUD de agente (create → update → delete)", async ({ terosPage }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId, "private workspace resuelto").toBeTruthy()
    const wid = privateWorkspaceId as string
    const fullName = `Pw Agent ${Date.now()}`

    // create — coreId derived from an existing agent (PwBot → core:pw-test).
    const agentId = await evalTeros(
      terosPage,
      async ({ wid, fullName }) => {
        const coreId = (await window.teros.agent.listAgents()).agents?.[0]?.coreId || "core:pw-test"
        const r = await window.teros.agent.createAgent({
          coreId,
          name: "PwCrud",
          fullName,
          role: "tester",
          intro: "CRUD smoke agent",
          workspaceId: wid,
        })
        return r.agent.agentId
      },
      { wid, fullName },
    )
    expect(agentId, "createAgent devuelve agentId").toBeTruthy()

    const present = await evalTeros(
      terosPage,
      async ({ wid, id }) =>
        (await window.teros.agent.listAgents(wid)).agents.some((a) => a.agentId === id),
      { wid, id: agentId },
    )
    expect(present, "agente presente en listAgents tras create").toBe(true)

    // update
    const newName = `${fullName} v2`
    await evalTeros(
      terosPage,
      ({ id, newName }) =>
        window.teros.agent.updateAgent({ agentId: id, fullName: newName }).then(() => null),
      { id: agentId, newName },
    )
    const renamed = await evalTeros(
      terosPage,
      async ({ wid, id }) =>
        (await window.teros.agent.listAgents(wid)).agents.find((a) => a.agentId === id)?.fullName,
      { wid, id: agentId },
    )
    expect(renamed, "fullName actualizado").toBe(newName)

    // delete
    await evalTeros(terosPage, (id) => window.teros.agent.deleteAgent(id).then(() => null), agentId)
    const absent = await evalTeros(
      terosPage,
      async ({ wid, id }) =>
        !(await window.teros.agent.listAgents(wid)).agents.some((a) => a.agentId === id),
      { wid, id: agentId },
    )
    expect(absent, "agente ausente tras delete").toBe(true)

    const errs = capturedErrors(terosPage)
    if (errs.network.length)
      console.log(`⚠️  network 4xx/5xx: ${[...new Set(errs.network)].join(", ")}`)
    expect(errs.console, errs.console.join("\n")).toEqual([])
    expect(errs.page, errs.page.join("\n")).toEqual([])
  })

  test("create/update/delete propagan en realtime a una 2ª sesión @realtime", async ({
    terosPage,
    secondUser1Page,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId).toBeTruthy()
    const wid = privateWorkspaceId as string
    const fullName = `Pw RT Agent ${Date.now()}`

    // CREATE — the second session must receive the push AND see the agent listed.
    await clearEvents(secondUser1Page)
    const agentId = await evalTeros(
      terosPage,
      async ({ wid, fullName }) => {
        const coreId = (await window.teros.agent.listAgents()).agents?.[0]?.coreId || "core:pw-test"
        const r = await window.teros.agent.createAgent({
          coreId,
          name: "PwRt",
          fullName,
          role: "tester",
          intro: "realtime smoke agent",
          workspaceId: wid,
        })
        return r.agent.agentId
      },
      { wid, fullName },
    )
    expect(
      await waitForEvent(secondUser1Page, { type: "agent.created" }, 8000),
      "evento agent.created recibido en la 2ª sesión",
    ).toBeTruthy()
    const seenB = await evalTeros(
      secondUser1Page,
      async ({ wid, id }) =>
        (await window.teros.agent.listAgents(wid)).agents.some((a) => a.agentId === id),
      { wid, id: agentId },
    )
    expect(seenB, "la 2ª sesión ve el agente nuevo").toBe(true)

    // UPDATE
    await clearEvents(secondUser1Page)
    const newName = `${fullName} v2`
    await evalTeros(
      terosPage,
      ({ id, newName }) =>
        window.teros.agent.updateAgent({ agentId: id, fullName: newName }).then(() => null),
      { id: agentId, newName },
    )
    expect(
      await waitForEvent(secondUser1Page, { type: "agent.updated" }, 8000),
      "evento agent.updated recibido",
    ).toBeTruthy()

    // DELETE
    await clearEvents(secondUser1Page)
    await evalTeros(terosPage, (id) => window.teros.agent.deleteAgent(id).then(() => null), agentId)
    expect(
      await waitForEvent(secondUser1Page, { type: "agent.deleted" }, 8000),
      "evento agent.deleted recibido",
    ).toBeTruthy()
    const goneB = await evalTeros(
      secondUser1Page,
      async ({ wid, id }) =>
        !(await window.teros.agent.listAgents(wid)).agents.some((a) => a.agentId === id),
      { wid, id: agentId },
    )
    expect(goneB, "la 2ª sesión ya no ve el agente").toBe(true)
  })
})
