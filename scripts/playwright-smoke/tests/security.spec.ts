/**
 * Negative authz — cross-workspace. For each fix in the TER-399 release that added an
 * authorization gate, prove the SAME resource yields: owner → allowed, stranger
 * (user2, NOT a member of user1's private workspace) → DENIED with the gate's exact
 * code + message. user1 (terosPage) owns the private workspace; user2 (user2Page) is a
 * different authenticated user. Resources are created hot and cleaned up in `finally`.
 *
 * Why this is the strong shape: the owner-OK sanity rules out "denied because the
 * resource didn't exist", so the stranger's denial is unambiguously an authz decision.
 *
 * Mutation check (run by the verification step): comment out the `throw new
 * HandlerError(...)` in any gate → the stranger's action resolves → `resolved` flips to
 * true → the matching assertion goes red. `code` is the contract (preserved by the
 * ws-transport fix); `message` is the backend's literal string.
 */
import { expect, test } from "../fixtures"
import { attemptAction, evalTeros, getPrimaryIds } from "../helpers/teros"

type Denial = { resolved: boolean; message: string | null; code: string | null }

/** Rejected + exact code + message substring of the gate. One place for the triple. */
function expectDenied(r: Denial, code: string, msgContains: string, label: string): void {
  expect(
    r.resolved,
    `${label}: debía ser DENEGADO pero la acción tuvo ÉXITO (agujero de authz)`,
  ).toBe(false)
  expect(r.code, `${label}: code`).toBe(code)
  expect(r.message ?? "", `${label}: message`).toContain(msgContains)
}

test.describe("security — cross-workspace authz @security", () => {
  // 1) project (TER-509 / #210) — gate canAccessWorkspace → FORBIDDEN "No access to this project"
  test("user2 no puede leer/editar/borrar un project privado de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId, "privateWorkspaceId de user1").toBeTruthy()
    const projectId = await evalTeros(
      terosPage,
      (wid) =>
        window.teros.board
          .createProject(wid, `Sec proj ${Date.now()}`)
          .then((r) => r.project.projectId),
      privateWorkspaceId,
    )
    try {
      const owner = await attemptAction(terosPage, "project.get", { projectId })
      expect(owner.resolved, "el owner (user1) SÍ accede a su project").toBe(true)

      expectDenied(
        await attemptAction(user2Page, "project.get", { projectId }),
        "FORBIDDEN",
        "No access to this project",
        "project.get",
      )
      expectDenied(
        await attemptAction(user2Page, "project.update", { projectId, name: "hacked" }),
        "FORBIDDEN",
        "No access to this project",
        "project.update",
      )
      expectDenied(
        await attemptAction(user2Page, "project.delete", { projectId }),
        "FORBIDDEN",
        "No access to this project",
        "project.delete",
      )
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.board.deleteProject(id).catch(() => null),
        projectId,
      )
    }
  })

  // 2) agent (TER-513 / #211) — gate ownerId === caller → AGENT_NOT_FOUND (existence-hiding).
  // Uses an EPHEMERAL agent (not the seed agent) so a broken delete gate can't poison the env.
  test("user2 no puede editar/borrar un agente de user1", async ({ terosPage, user2Page }) => {
    const agentId = await evalTeros(terosPage, async () => {
      const agents = (await window.teros.agent.listAgents()).agents || []
      const coreId = agents[0]?.coreId || "core:pw-test"
      const r = await window.teros.agent.createAgent({
        coreId,
        name: "SecBot",
        fullName: `Sec Agent ${Date.now()}`,
        role: "sec",
        intro: "security smoke",
      })
      return r.agent.agentId
    })
    try {
      const seen = await evalTeros(
        terosPage,
        (id) => window.teros.agent.listAgents().then((r) => r.agents.some((a) => a.agentId === id)),
        agentId,
      )
      expect(seen, "el owner (user1) ve su agente").toBe(true)

      expectDenied(
        await attemptAction(user2Page, "agent.update", { agentId, name: "hacked" }),
        "AGENT_NOT_FOUND",
        "not found or access denied",
        "agent.update",
      )
      expectDenied(
        await attemptAction(user2Page, "agent.delete", { agentId }),
        "AGENT_NOT_FOUND",
        "not found or access denied",
        "agent.delete",
      )
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.agent.deleteAgent(id).catch(() => null),
        agentId,
      )
    }
  })

  // 3) app (TER-513 / #211) — uninstall (UNINSTALL_APP_ERROR) + list-tools (ACCESS_DENIED).
  // app.list-tools denies BEFORE spawning the container, so no MCA runtime is needed.
  test("user2 no puede desinstalar ni listar tools de una app de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const appId = await evalTeros(terosPage, async () => {
      const { catalog } = await window.teros.app.listCatalog()
      const usable =
        catalog.find(
          (m) => (m as { availability?: { enabled?: boolean } }).availability?.enabled !== false,
        ) ?? catalog[0]
      const r = await window.teros.app.installApp(usable.mcaId)
      return r.app.appId
    })
    expect(appId, "app instalada por user1").toBeTruthy()
    try {
      expectDenied(
        await attemptAction(user2Page, "app.uninstall", { appId }),
        "UNINSTALL_APP_ERROR",
        "App not found or access denied",
        "app.uninstall",
      )
      expectDenied(
        await attemptAction(user2Page, "app.list-tools", { appId }),
        "ACCESS_DENIED",
        "You don't have access to app",
        "app.list-tools",
      )
    } finally {
      await evalTeros(terosPage, (id) => window.teros.app.uninstallApp(id).catch(() => null), appId)
    }
  })

  // 4) skill (TER-481 / #173) — gate canAccessWorkspace → FORBIDDEN_WORKSPACE "No access to workspace".
  // skill.* has no typed sub-API on window.teros → driven via transport.request.
  test("user2 no puede editar/borrar un skill de user1", async ({ terosPage, user2Page }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    const skillId = await evalTeros(
      terosPage,
      (wid) =>
        window.teros.transport
          .request("skill.create", {
            workspaceId: wid,
            name: `Sec skill ${Date.now()}`,
            content: "secret",
          })
          .then((r) => (r as { skill: { skillId: string } }).skill.skillId),
      privateWorkspaceId,
    )
    expect(skillId, "skill creado por user1").toBeTruthy()
    try {
      expectDenied(
        await attemptAction(user2Page, "skill.update", { skillId, name: "hacked" }),
        "FORBIDDEN_WORKSPACE",
        "No access to workspace",
        "skill.update",
      )
      expectDenied(
        await attemptAction(user2Page, "skill.delete", { skillId }),
        "FORBIDDEN_WORKSPACE",
        "No access to workspace",
        "skill.delete",
      )
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.transport.request("skill.delete", { skillId: id }).catch(() => null),
        skillId,
      )
    }
  })

  // 5) scheduler (TER-358 / #174) — channel-ownership gate → FORBIDDEN "does not belong to user".
  test("user2 no puede programar un reminder en un canal de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    const channelId = await evalTeros(
      terosPage,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId, wid: privateWorkspaceId },
    )
    expect(channelId, "canal creado por user1 (shape ch_<16hex>)").toMatch(/^ch_[0-9a-f]{16}$/)
    try {
      expectDenied(
        await attemptAction(user2Page, "scheduler.schedule-reminder", {
          channelId,
          message: "x",
          time: "in 1 hour",
        }),
        "FORBIDDEN",
        "does not belong to user",
        "scheduler.schedule-reminder",
      )
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.channel.close(id).catch(() => null),
        channelId,
      )
    }
  })

  // 6) board (#153) — write-role gate → FORBIDDEN "No write access[ to this workspace]".
  test("user2 no puede crear project/task en el espacio de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    const projectId = await evalTeros(
      terosPage,
      (wid) =>
        window.teros.board
          .createProject(wid, `Sec board ${Date.now()}`)
          .then((r) => r.project.projectId),
      privateWorkspaceId,
    )
    try {
      expectDenied(
        await attemptAction(user2Page, "board.create-project", {
          workspaceId: privateWorkspaceId,
          name: "intruso",
        }),
        "FORBIDDEN",
        "No write access to this workspace",
        "board.create-project",
      )
      expectDenied(
        await attemptAction(user2Page, "board.create-task", { projectId, title: "intruso" }),
        "FORBIDDEN",
        "No write access",
        "board.create-task",
      )
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.board.deleteProject(id).catch(() => null),
        projectId,
      )
    }
  })

  // 7) set-channel-project (project #210 / TER-509) — channel-ownership gate → FORBIDDEN "Not your channel".
  test("user2 no puede asociar un canal de user1 a un proyecto", async ({
    terosPage,
    user2Page,
  }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    const channelId = await evalTeros(
      terosPage,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId, wid: privateWorkspaceId },
    )
    try {
      // El canal de user1 EXISTE, así que el gate decide por ownership (no por not-found).
      expectDenied(
        await attemptAction(user2Page, "project.set-channel-project", { channelId, projectId: null }),
        "FORBIDDEN",
        "Not your channel",
        "project.set-channel-project",
      )
    } finally {
      await evalTeros(terosPage, (id) => window.teros.channel.close(id).catch(() => null), channelId)
    }
  })

  // 8) agent read-side (TER-513 / #211) — canAccessAgent gate en list-providers/get-apps → FORBIDDEN "No access to this agent".
  test("user2 no puede leer providers ni apps del agente de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { agentId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    const seen = await evalTeros(
      terosPage,
      (id) => window.teros.agent.listAgents().then((r) => r.agents.some((a) => a.agentId === id)),
      agentId,
    )
    expect(seen, "el owner (user1) ve su agente").toBe(true)

    expectDenied(
      await attemptAction(user2Page, "agent.list-providers", { agentId }),
      "FORBIDDEN",
      "No access to this agent",
      "agent.list-providers",
    )
    expectDenied(
      await attemptAction(user2Page, "agent.get-apps", { agentId }),
      "FORBIDDEN",
      "No access to this agent",
      "agent.get-apps",
    )
  })
})
