/**
 * Cross-user realtime — user1 owns the shared workspace, user2 is a member. Mutations
 * by user1 must fan out to user2's session (broadcastToWorkspace, TER-304). Two real
 * authenticated sessions of DIFFERENT users (user1 storageState + user2 storageState).
 */
import { expect, test } from "../fixtures"
import { clearEvents, evalTeros, waitForEvent } from "../helpers/teros"

test.describe("cross-user @crossuser", () => {
  test("workspace.update en el workspace compartido llega al miembro @realtime", async ({
    terosPage,
    user2Page,
    seed,
  }) => {
    const sharedId = seed.sharedWorkspaceId
    expect(sharedId, "shared workspace seedeado").toBeTruthy()

    // Sanity: user2 actually sees the shared workspace (membership).
    const memberSees = await evalTeros(
      user2Page,
      (id) => window.teros.listWorkspaces().then((wss) => wss.some((w) => w.workspaceId === id)),
      sharedId,
    )
    expect(memberSees, "user2 es miembro del workspace compartido").toBe(true)

    const newName = `Pw Shared ${Date.now()}`
    await clearEvents(user2Page)
    await evalTeros(
      terosPage,
      ({ id, newName }) =>
        window.teros.workspace.updateWorkspace({ workspaceId: id, name: newName }).then(() => null),
      { id: sharedId, newName },
    )
    expect(
      await waitForEvent(user2Page, { type: "workspace.updated" }, 8000),
      "el miembro (user2) recibe workspace.updated",
    ).toBeTruthy()
    const memberHasNewName = await evalTeros(
      user2Page,
      ({ id, newName }) =>
        window.teros
          .listWorkspaces()
          .then((wss) => wss.find((w) => w.workspaceId === id)?.name === newName),
      { id: sharedId, newName },
    )
    expect(memberHasNewName, "user2 ve el nombre actualizado del workspace compartido").toBe(true)
  })

  test("agent.create en el workspace compartido lo ve el miembro @realtime", async ({
    terosPage,
    user2Page,
    seed,
  }) => {
    const sharedId = seed.sharedWorkspaceId
    const fullName = `Pw Cross Agent ${Date.now()}`

    await clearEvents(user2Page)
    const agentId = await evalTeros(
      terosPage,
      async ({ wid, fullName }) => {
        const coreId = (await window.teros.agent.listAgents()).agents?.[0]?.coreId || "core:pw-test"
        const r = await window.teros.agent.createAgent({
          coreId,
          name: "XBot",
          fullName,
          role: "cross",
          intro: "cross-user smoke agent",
          workspaceId: wid,
        })
        return r.agent.agentId
      },
      { wid: sharedId, fullName },
    )
    expect(
      await waitForEvent(user2Page, { type: "agent.created" }, 8000),
      "el miembro (user2) recibe agent.created",
    ).toBeTruthy()
    const memberSeesAgent = await evalTeros(
      user2Page,
      ({ wid, id }) =>
        window.teros.agent.listAgents(wid).then((r) => r.agents.some((a) => a.agentId === id)),
      { wid: sharedId, id: agentId },
    )
    expect(memberSeesAgent, "user2 ve el agente creado en el workspace compartido").toBe(true)

    // cleanup — owner deletes the agent it created
    await evalTeros(terosPage, (id) => window.teros.agent.deleteAgent(id).then(() => null), agentId)
  })
})
