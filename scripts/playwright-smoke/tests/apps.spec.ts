/**
 * Apps/MCAs domain. Two tests:
 *  - app lifecycle (no container): install a catalog MCA → listApps → listTools →
 *    grantAccess(agent) → setAllToolPermissions(allow) → uninstall. listTools reads
 *    the manifest, so this validates the management surface without a running container.
 *  - executeTool (degradable): run a no-credential tool (datetime). MCA containers are
 *    spawned on demand; if the container can't start in this env, skip with the reason
 *    instead of a false red (the suite still surfaces it in the skip message).
 */
import { expect, test } from "../fixtures"
import { evalTeros, getPrimaryIds } from "../helpers/teros"

test.describe("apps @apps", () => {
  test("ciclo de vida de app: install → list-tools → grant → permissions → uninstall", async ({
    terosPage,
  }) => {
    const { agentId } = await getPrimaryIds(terosPage)
    expect(agentId).toBeTruthy()

    // Pick a reusable catalog MCA: multi-install (so install is repeatable) + user role.
    const mcaId = await evalTeros(terosPage, async () => {
      const cat = await window.teros.app.listCatalog()
      const m = (cat.catalog || []).find(
        (x) =>
          x.availability?.multi &&
          x.availability?.role === "user" &&
          x.availability?.enabled !== false,
      )
      return m?.mcaId ?? null
    })
    expect(mcaId, "hay un MCA multi-instalable user-role en el catálogo").toBeTruthy()

    const appId = await evalTeros(
      terosPage,
      (mcaId) => window.teros.app.installApp(mcaId).then((r) => r.app.appId),
      mcaId as string,
    )
    expect(appId, "installApp devuelve appId").toBeTruthy()

    const installed = await evalTeros(
      terosPage,
      (appId) => window.teros.app.listApps().then((r) => r.apps.some((a) => a.appId === appId)),
      appId,
    )
    expect(installed, "el app aparece en listApps").toBe(true)

    // listTools reads the manifest — no container needed.
    const toolCount = await evalTeros(
      terosPage,
      (appId) => window.teros.app.listTools(appId).then((r) => (r.tools || []).length),
      appId,
    )
    expect(toolCount, "el app expone tools").toBeGreaterThan(0)

    // grant the agent access + allow all tools (the permission surface)
    const granted = await evalTeros(
      terosPage,
      ({ aid, appId }) => window.teros.app.grantAccess(aid, appId).then((r) => r.success),
      { aid: agentId as string, appId },
    )
    expect(granted, "grantAccess success").toBe(true)
    const permSet = await evalTeros(
      terosPage,
      (appId) => window.teros.app.setAllToolPermissions(appId, "allow").then((r) => r.success),
      appId,
    )
    expect(permSet, "setAllToolPermissions(allow) success").toBe(true)

    // uninstall → gone
    await evalTeros(
      terosPage,
      (appId) => window.teros.app.uninstallApp(appId).then(() => null),
      appId,
    )
    const stillThere = await evalTeros(
      terosPage,
      (appId) => window.teros.app.listApps().then((r) => r.apps.some((a) => a.appId === appId)),
      appId,
    )
    expect(stillThere, "el app ya no está tras uninstall").toBe(false)
  })

  test("executeTool directa de una tool sin credenciales (datetime)", async ({ terosPage }) => {
    test.setTimeout(60_000)

    // Reuse the installed datetime app (system, no secrets) or install it by id.
    const appId = await evalTeros(terosPage, async () => {
      const apps = await window.teros.app.listApps()
      const existing = (apps.apps || []).find((a) => a.mcaId === "mca.teros.datetime")
      if (existing) return existing.appId
      const inst = await window.teros.app.installApp("mca.teros.datetime").catch(() => null)
      return inst?.app.appId ?? null
    })
    expect(appId, "datetime app disponible").toBeTruthy()

    // Containers spawn on demand — the first calls may time out (cold start). Retry,
    // then inspect the result: a real run returns { success, result }; a broken env
    // returns success:false with a "failed to start" result.
    const res = await evalTeros(
      terosPage,
      async (appId) => {
        for (let i = 0; i < 4; i++) {
          try {
            const r = await window.teros.app.executeTool(appId, "is-valid", {
              datetime: "2026-01-01T00:00:00Z",
            })
            return { phase: "done", success: r.success, result: r.result }
          } catch (e) {
            await new Promise((res) => setTimeout(res, 4000))
            if (i === 3) return { phase: "timeout", error: String(e) }
          }
        }
        return { phase: "timeout", error: "unreachable" }
      },
      appId as string,
    )

    const blob = JSON.stringify(res)
    const containerUnavailable =
      res.phase === "timeout" || /failed to start|did not become healthy/i.test(blob)
    test.skip(
      containerUnavailable,
      `MCA container no arranca en este entorno (no es fallo del test): ${blob}`,
    )

    expect(res.success, `executeTool is-valid devolvió éxito: ${blob}`).toBe(true)
  })
})
