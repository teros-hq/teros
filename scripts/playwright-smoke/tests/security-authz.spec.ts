/**
 * Negative authz — second wave (TER-550 / release 2026-06-11). Completes the
 * cross-workspace + IDOR + admin gates that `security.spec.ts` left uncovered.
 *
 * Two shapes here:
 *  - Cross-workspace (skill.get/list/create #173, project.list #210, file.share
 *    WS #172): owner (user1, member) OK / stranger (user2) DENIED with the gate's
 *    exact code + message. The owner-OK sanity rules out "denied because absent".
 *  - System-admin gates (agent.update-core / app.update-mca / app.list-all-mcas
 *    #211): the prod hole was "ANY authenticated user could". Seed has no admin,
 *    so we prove BOTH normal users (owner-side user1 AND stranger user2) are
 *    denied — i.e. no founding-partner account passes the gate.
 *
 * Mutation check (verification step): no-op the gate (`if (false && …)` or remove
 * `await requireSystemAdmin(…)`) → the action resolves → `resolved` flips true →
 * the matching assertion goes red. Real coreId/mcaId are passed to the admin
 * cases ONLY so the mutated path returns data (resolved:true) instead of
 * NOT_FOUND; the live (gated) run never reaches the lookup.
 */
import { expect, test } from "../fixtures"
import { attemptAction, evalTeros, getPrimaryIds } from "../helpers/teros"

type Denial = { resolved: boolean; message: string | null; code: string | null }

function expectDenied(r: Denial, code: string, msgContains: string, label: string): void {
  expect(
    r.resolved,
    `${label}: debía ser DENEGADO pero la acción tuvo ÉXITO (agujero de authz)`,
  ).toBe(false)
  expect(r.code, `${label}: code`).toBe(code)
  expect(r.message ?? "", `${label}: message`).toContain(msgContains)
}

test.describe("security authz (2ª ola) — cross-workspace + IDOR @security", () => {
  // skill READ-side (TER-481 / #173 bug0) — get/list gated by canAccessWorkspace.
  // security.spec covers update/delete; this covers the read leak (content
  // exfiltration: a skill's Markdown is injected into the owner's system prompt).
  test("user2 no puede LEER (get/list) un skill de user1", async ({ terosPage, user2Page }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId, "privateWorkspaceId de user1").toBeTruthy()
    const skillId = await evalTeros(
      terosPage,
      (wid) =>
        window.teros.transport
          .request("skill.create", {
            workspaceId: wid,
            name: `SecRead skill ${Date.now()}`,
            content: "TOP SECRET workspace knowledge",
          })
          .then((r) => (r as { skill: { skillId: string } }).skill.skillId),
      privateWorkspaceId,
    )
    expect(skillId, "skill creado por user1").toBeTruthy()
    try {
      const owner = await attemptAction(terosPage, "skill.get", { skillId })
      expect(owner.resolved, "el owner (user1) SÍ lee su skill").toBe(true)

      expectDenied(
        await attemptAction(user2Page, "skill.get", { skillId }),
        "FORBIDDEN_WORKSPACE",
        "No access to workspace",
        "skill.get",
      )
      expectDenied(
        await attemptAction(user2Page, "skill.list", { workspaceId: privateWorkspaceId }),
        "FORBIDDEN_WORKSPACE",
        "No access to workspace",
        "skill.list",
      )
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.transport.request("skill.delete", { skillId: id }).catch(() => null),
        skillId,
      )
    }
  })

  // skill CREATE in a foreign workspace (TER-481 / #173 bug3) — inject a resource
  // into someone else's sovereign workspace. Gate: canAccessWorkspace on payload wid.
  test("user2 no puede CREAR un skill en el workspace de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId, "privateWorkspaceId de user1").toBeTruthy()
    // Owner-OK sanity: user1 CAN create in their own ws (cleaned up immediately).
    const ownSkillId = await evalTeros(
      terosPage,
      (wid) =>
        window.teros.transport
          .request("skill.create", { workspaceId: wid, name: `Own ${Date.now()}`, content: "x" })
          .then((r) => (r as { skill: { skillId: string } }).skill.skillId)
          .catch(() => null),
      privateWorkspaceId,
    )
    expect(ownSkillId, "el owner (user1) SÍ crea en su ws").toBeTruthy()
    await evalTeros(
      terosPage,
      (id) => window.teros.transport.request("skill.delete", { skillId: id }).catch(() => null),
      ownSkillId,
    )

    expectDenied(
      await attemptAction(user2Page, "skill.create", {
        workspaceId: privateWorkspaceId,
        name: "intruso",
        content: "evil",
      }),
      "FORBIDDEN_WORKSPACE",
      "No access to workspace",
      "skill.create",
    )
  })

  // project READ-side list (TER-509 / #210 bug0) — list returns ALL projects of an
  // arbitrary foreign workspaceId. security.spec covers project.get/update/delete;
  // this covers list. Gate → FORBIDDEN "No access to this workspace".
  test("user2 no puede LISTAR los projects del workspace de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId, "privateWorkspaceId de user1").toBeTruthy()
    const owner = await attemptAction(terosPage, "project.list", {
      workspaceId: privateWorkspaceId,
    })
    expect(owner.resolved, "el owner (user1) SÍ lista sus projects").toBe(true)

    expectDenied(
      await attemptAction(user2Page, "project.list", { workspaceId: privateWorkspaceId }),
      "FORBIDDEN",
      "No access to this workspace",
      "project.list",
    )
  })

  // file.share WS path (TER-480 / #172 bug0) — resolveAuthorizedWorkspace gates the
  // WS `file.share` action by channel→workspace membership. A stranger knowing a
  // channelId could otherwise publish the foreign workspace's volume files.
  // NOTE: the REST /api/share path is the one the frontend uses; see report.
  test("user2 no puede compartir (WS file.share) un archivo del workspace de user1", async ({
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
      // The gate (FORBIDDEN_WORKSPACE) fires before any file lookup, so the
      // stranger is denied regardless of whether the path exists.
      expectDenied(
        await attemptAction(user2Page, "file.share", {
          channelId,
          filePath: "/index.html",
          fileType: "html",
        }),
        "FORBIDDEN_WORKSPACE",
        "No access to workspace",
        "file.share",
      )
      expectDenied(
        await attemptAction(user2Page, "file.get-share", { channelId, filePath: "/index.html" }),
        "FORBIDDEN_WORKSPACE",
        "No access to workspace",
        "file.get-share",
      )
    } finally {
      await evalTeros(terosPage, (id) => window.teros.channel.close(id).catch(() => null), channelId)
    }
  })

  // System-admin gates (TER-513 / #211 bugs 0,1,2) — any authenticated user could
  // mutate global catalog/core state. Seed has no admin; prove BOTH normal users
  // are denied (no founding-partner passes). Real ids passed so a no-op'd gate
  // resolves (mutation goes red); the gated run rejects before the lookup.
  test("ningún usuario normal puede tocar agent-cores ni el catálogo MCA (admin gate)", async ({
    terosPage,
    user2Page,
  }) => {
    // Resolve a real coreId + mcaId so the MUTATED path reaches a real record.
    const realCoreId = await evalTeros(terosPage, async () => {
      const agents = (await window.teros.agent.listAgents()).agents || []
      return agents[0]?.coreId ?? "core:pw-test"
    })
    const realMcaId = await evalTeros(terosPage, async () => {
      const { catalog } = await window.teros.app.listCatalog()
      return catalog[0]?.mcaId ?? "mca.teros.core"
    })

    // agent.update-core (empty updates → harmless if the gate were ever bypassed).
    for (const [page, who] of [
      [terosPage, "user1"],
      [user2Page, "user2"],
    ] as const) {
      expectDenied(
        await attemptAction(page, "agent.update-core", { coreId: realCoreId, updates: {} }),
        "FORBIDDEN",
        "Admin privileges required",
        `agent.update-core (${who})`,
      )
      expectDenied(
        await attemptAction(page, "app.update-mca", { mcpId: realMcaId, updates: {} }),
        "FORBIDDEN",
        "Admin privileges required",
        `app.update-mca (${who})`,
      )
      expectDenied(
        await attemptAction(page, "app.list-all-mcas", {}),
        "FORBIDDEN",
        "Admin privileges required",
        `app.list-all-mcas (${who})`,
      )
    }
  })
})
