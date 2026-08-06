/**
 * Agent-core gradual rollout — end-to-end via the real authenticated client (TER-412).
 *
 * The unit/integration suite covers the resolver + bucketing + applyCoreRollout
 * against Mongo directly. This spec covers what they can't:
 *  1. Happy path through window.teros as SUPER: create an experimental core, force
 *     the super's own agents onto it (user override → bounded blast radius), apply
 *     → the agent's coreId actually flips; remove the override + apply → it reverts.
 *     Plus the set-rollout/clear-rollout % path (read back via listFeatureFlags).
 *  2. Negative authz: set-rollout / core-rollout-apply / clear-rollout /
 *     feature-flags-list are super-only (user2 = plain user → FORBIDDEN).
 *  3. Render: /admin/agent-cores loads for a super with no JS errors, shows the
 *     "Create core" action, and has no raw i18n keys leaking.
 *
 * Reversible + bounded: it creates its own throwaway core + agent, forces ONLY the
 * super's agents (override, not a global %), and reverts + deactivates + clears in
 * finally — other specs (workers:1, shared DB) see the DB as they left it.
 */
import { capturedErrors, expect, test } from "../fixtures"
import { attemptAction, evalTeros } from "../helpers/teros"
import { closeDb, deleteAgentCore } from "../helpers/db"

test.afterAll(async () => {
  await closeDb()
})

const FLAG = "core.agent"

type Denial = { resolved: boolean; message: string | null; code: string | null }
function expectDenied(r: Denial, code: string, msgContains: string, label: string): void {
  expect(r.resolved, `${label}: debía ser DENEGADO (super-only) pero tuvo ÉXITO`).toBe(false)
  expect(r.code, `${label}: code`).toBe(code)
  expect(r.message ?? "", `${label}: message`).toContain(msgContains)
}

test.describe("agent-core rollout @admin", () => {
  test("super: create-core → override+apply migra el agente → revert lo devuelve; set/clear %", async ({
    superPage,
    seed,
  }) => {
    const superUserId = seed.user3.userId
    expect(superUserId, "userId del super (seed.user3)").toBeTruthy()

    // Resolver el modelId/defaultApps del core estable y el workspace privado del super.
    const ctx = await evalTeros(superPage, async () => {
      const cores = (await window.teros.agent.listCores()).cores
      const stable = cores.find((c: { coreId: string }) => c.coreId === "agent")
      const wss = await window.teros.listWorkspaces()
      const priv = wss.find((w: { type: string }) => w.type === "private") || wss[0]
      return {
        modelId: stable?.modelId as string | undefined,
        defaultApps: (stable?.defaultApps as string[] | undefined) || [],
        wsId: priv?.workspaceId as string | undefined,
      }
    })
    expect(ctx.modelId, "modelId del core estable 'agent'").toBeTruthy()
    expect(ctx.wsId, "workspace privado del super").toBeTruthy()

    const expCoreId = `agent-rollout-smoke-${Date.now()}`
    let testAgentId = ""

    try {
      // 1. Crear el core experimental (mismo modelo/apps que el estable → reversible sin drift).
      const created = await evalTeros(
        superPage,
        async (a: { expCoreId: string; modelId: string; defaultApps: string[] }) =>
          (
            await window.teros.agent.createCore({
              coreId: a.expCoreId,
              coreType: "agent",
              name: "Rollout Smoke",
              fullName: "Rollout Smoke Core",
              systemPrompt: "Experimental rollout-smoke core.",
              modelId: a.modelId,
              defaultApps: a.defaultApps,
            })
          ).core,
        { expCoreId, modelId: ctx.modelId as string, defaultApps: ctx.defaultApps },
      )
      expect(created.status, "create-core nace active").toBe("active")
      expect(created.coreType).toBe("agent")

      // 2. Crear un agente de prueba del super (workspace-scoped → nace en el core canónico 'agent').
      testAgentId = await evalTeros(
        superPage,
        async (wsId: string) =>
          (
            await window.teros.agent.createAgent({
              name: "RolloutSmokeAgent",
              fullName: "Rollout Smoke Agent",
              role: "test",
              intro: "smoke",
              workspaceId: wsId,
            })
          ).agent.agentId,
        ctx.wsId as string,
      )
      expect(testAgentId, "agente de prueba creado").toBeTruthy()

      const coreIdOf = async (agentId: string): Promise<string | undefined> =>
        evalTeros(
          superPage,
          async (id: string) => {
            const r = await window.teros.admin.listAllAgents({ includeAll: true })
            return r.agents.find((a: { agentId: string }) => a.agentId === id)?.coreId
          },
          agentId,
        )
      expect(await coreIdOf(testAgentId), "el agente nace en el core canónico").toBe("agent")

      // 3. Forzar SOLO los agentes del super al experimental (override por user → blast radius acotado).
      await evalTeros(
        superPage,
        (a: { key: string; uid: string; core: string }) =>
          window.teros.admin.setFeatureFlagOverride(a.key, "user", a.uid, a.core),
        { key: FLAG, uid: superUserId, core: expCoreId },
      )

      // 4. Aplicar → el agente del super migra; los de otros owners quedan unchanged.
      const up = await evalTeros(superPage, () => window.teros.admin.applyCoreRollout("agent"))
      expect(up.migrated, "apply migró al menos el agente del super").toBeGreaterThanOrEqual(1)
      expect(await coreIdOf(testAgentId), "el agente quedó en el core experimental").toBe(expCoreId)

      // 5. Quitar el override + aplicar → vuelve al canónico.
      await evalTeros(
        superPage,
        (a: { key: string; uid: string }) =>
          window.teros.admin.deleteFeatureFlagOverride(a.key, "user", a.uid),
        { key: FLAG, uid: superUserId },
      )
      const down = await evalTeros(superPage, () => window.teros.admin.applyCoreRollout("agent"))
      expect(down.reverted, "apply revirtió al menos el agente del super").toBeGreaterThanOrEqual(1)
      expect(await coreIdOf(testAgentId), "el agente volvió al core canónico").toBe("agent")

      // 6. Camino del % puro: set 50% → leer del flag → clear → leído sin rollout.
      await evalTeros(
        superPage,
        (a: { key: string; core: string }) =>
          window.teros.admin.setFeatureFlagRollout(a.key, a.core, 50),
        { key: FLAG, core: expCoreId },
      )
      const withRollout = await evalTeros(superPage, (key: string) =>
        window.teros.admin
          .listFeatureFlags()
          .then((r) => r.flags.find((f: { key: string }) => f.key === key)?.rollout),
        FLAG,
      )
      expect(withRollout, "el flag refleja el rollout fijado").toMatchObject({
        value: expCoreId,
        percentage: 50,
      })
      await evalTeros(superPage, (key: string) => window.teros.admin.clearFeatureFlagRollout(key), FLAG)
      const cleared = await evalTeros(superPage, (key: string) =>
        window.teros.admin
          .listFeatureFlags()
          .then((r) => r.flags.find((f: { key: string }) => f.key === key)?.rollout),
        FLAG,
      )
      expect(cleared ?? null, "clear-rollout dejó el flag sin rollout").toBeNull()
    } finally {
      // Cleanup — dejar la DB como estaba para los demás specs (workers:1).
      await evalTeros(
        superPage,
        async (a: { key: string; uid: string; agentId: string; core: string }) => {
          try {
            await window.teros.admin.clearFeatureFlagRollout(a.key)
          } catch {}
          try {
            await window.teros.admin.deleteFeatureFlagOverride(a.key, "user", a.uid)
          } catch {}
          try {
            await window.teros.admin.applyCoreRollout("agent")
          } catch {}
          try {
            if (a.agentId) await window.teros.agent.deleteAgent(a.agentId)
          } catch {}
          try {
            await window.teros.agent.updateCore(a.core, { status: "inactive" })
          } catch {}
        },
        { key: FLAG, uid: superUserId, agentId: testAgentId, core: expCoreId },
      )
      // Hard-delete the throwaway core (no delete-core WS surface) so re-runs
      // don't pile up inactive cores.
      await deleteAgentCore(expCoreId).catch(() => {})
    }
  })

  test("non-super: set-rollout / apply / clear-rollout / list-flags → FORBIDDEN", async ({
    user2Page,
  }) => {
    const SUPER = "Super admin privileges required"
    expectDenied(
      await attemptAction(user2Page, "admin-api.feature-flags-set-rollout", {
        key: FLAG,
        value: "agent",
        percentage: 10,
      }),
      "FORBIDDEN",
      SUPER,
      "set-rollout",
    )
    expectDenied(
      await attemptAction(user2Page, "admin-api.core-rollout-apply", { coreType: "agent" }),
      "FORBIDDEN",
      SUPER,
      "core-rollout-apply",
    )
    expectDenied(
      await attemptAction(user2Page, "admin-api.feature-flags-clear-rollout", { key: FLAG }),
      "FORBIDDEN",
      SUPER,
      "clear-rollout",
    )
    expectDenied(
      await attemptAction(user2Page, "admin-api.feature-flags-list", {}),
      "FORBIDDEN",
      SUPER,
      "feature-flags-list",
    )
  })

  test("render: AgentCoresWindow carga para super sin errores JS ni i18n crudo", async ({
    superPage,
  }) => {
    // Abrir la ventana como un usuario real: el item "Agent Cores" del Navbar
    // (sección Admin). Navegar por URL no dispara openWindow en el tiling manager.
    // El botón "Create core" se acepta en los 3 locales (el del browser puede variar).
    const CREATE_RE = /Create core|Crear core|코어 생성/
    await superPage.getByText("Agent Cores", { exact: true }).first().click()
    await superPage
      .waitForFunction(() => /Create core|Crear core|코어 생성/.test(document.body.innerText), null, {
        timeout: 12000,
      })
      .catch(() => {})
    await superPage.waitForTimeout(1000)

    const body = await superPage.evaluate(() => document.body.innerText)
    expect(CREATE_RE.test(body), `la ventana muestra el botón Create core. Body: ${body.slice(0, 200)}`).toBe(true)
    const rawKey = (body.match(/agentCores\.[a-zA-Z]+/) || [])[0]
    expect(rawKey, `clave i18n cruda filtrada en la UI: ${rawKey}`).toBeFalsy()

    // Exercise the redesigned editor (split master-detail rewrite, ~1100 LOC):
    // opening the create form must render the CoreForm field sections. The labels
    // coreId/name/fullName/version are literal in the form and never appear in the
    // list — so their presence proves the CoreForm actually rendered (catches a
    // crash/blank in the rewrite that the static check above would miss). The
    // create form uses the SAME CoreForm component as edit, so this covers both.
    await superPage.getByText(CREATE_RE).first().click()
    await superPage
      .waitForFunction(() => /\bfullName\b/.test(document.body.innerText), null, { timeout: 8000 })
      .catch(() => {})
    const formBody = await superPage.evaluate(() => document.body.innerText)
    expect(
      /coreId/.test(formBody) && /fullName/.test(formBody) && /version/.test(formBody),
      `el form de crear core rinde sus campos (CoreForm). Body: ${formBody.slice(0, 300)}`,
    ).toBe(true)

    // 0 JS errors AFTER exercising the form render (covers the new interaction).
    const errs = capturedErrors(superPage)
    const jsErrs = [...errs.console, ...errs.page]
    expect(jsErrs, `errores JS en AgentCoresWindow: ${jsErrs.slice(0, 3).join(" | ")}`).toHaveLength(0)
  })
})
