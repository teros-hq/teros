/**
 * Unit tests — resolveMcaApp shared helper (Phase 7, SC1 / D-01 / D-02 / D-03 / D-04).
 *
 * Proves the deterministic mcaId → appId resolution contract that BOTH Phase 7
 * handlers (test-mca-tool + get-mca-resolvability) depend on, under the REVISED
 * workspace-scoped D-02 (07-03 spike: installed apps are workspace-owned in practice):
 *   - D-03 order: own user apps preferred over the admin's workspace apps, which are
 *     preferred over system apps — the first tier with a match wins.
 *   - workspace tier: resolves an app installed in a workspace the admin owns/belongs
 *     to; the FIRST workspace (sorted by workspaceId — D-04) with a match wins.
 *   - D-01: no match in any tier → typed not-installed variant (NO throw).
 *   - D-02 scope: only the admin's OWN workspaces are ever queried — the resolver calls
 *     listUserWorkspaces(userId) and listAppsByOwner only with the admin's userId, those
 *     workspace ids, and "system"; NEVER an arbitrary/other workspace id.
 *
 * No real MongoDB — a fake McaService exposes listAppsByOwner and a fake
 * WorkspaceService exposes listUserWorkspaces, both as mocks dispatching fixtures.
 */

import { describe, expect, it, mock } from "bun:test"
import {
  NOT_INSTALLED_REASON,
  resolveMcaApp,
} from "../../src/handlers/domains/app/mca-app-resolver"
import type { App, Workspace } from "../../src/types/database"

// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------

const USER_ADMIN = "user_admin"
const WS_A = "work_a"
const WS_B = "work_b"
const MCA_ID = "slack"

function makeApp(overrides: Partial<App> & Pick<App, "appId" | "mcaId" | "ownerId" | "name">): App {
  return {
    status: "active",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  }
}

function makeWorkspace(workspaceId: string): Workspace {
  return { workspaceId, ownerId: USER_ADMIN } as Workspace
}

const OWN_APP = makeApp({ appId: "app_own", mcaId: MCA_ID, ownerId: USER_ADMIN, name: "own-slack" })
const WS_A_APP = makeApp({
  appId: "app_ws_a",
  mcaId: MCA_ID,
  ownerId: WS_A,
  ownerType: "workspace",
  name: "wsa-slack",
})
const WS_B_APP = makeApp({
  appId: "app_ws_b",
  mcaId: MCA_ID,
  ownerId: WS_B,
  ownerType: "workspace",
  name: "wsb-slack",
})
const SYSTEM_APP = makeApp({
  appId: "app_sys",
  mcaId: MCA_ID,
  ownerId: "system",
  name: "sys-slack",
})

// A fake McaService exposing only listAppsByOwner, dispatching on ownerId.
function makeMcaService(byOwner: Record<string, App[]>) {
  const listAppsByOwner = mock(async (ownerId: string) => byOwner[ownerId] ?? [])
  const mcaService = { listAppsByOwner } as any
  return { mcaService, listAppsByOwner }
}

// A fake WorkspaceService exposing only listUserWorkspaces, returning the admin's
// workspaces in a deterministic order.
function makeWorkspaceService(workspaces: Workspace[]) {
  const listUserWorkspaces = mock(async (_userId: string) => workspaces)
  const workspaceService = { listUserWorkspaces } as any
  return { workspaceService, listUserWorkspaces }
}

// ===========================================================================

describe("resolveMcaApp", () => {
  it("(1) resolves a workspace-owned app for a workspace the admin belongs to", async () => {
    const { mcaService } = makeMcaService({ [USER_ADMIN]: [], [WS_A]: [WS_A_APP], system: [] })
    const { workspaceService } = makeWorkspaceService([makeWorkspace(WS_A)])

    const result = await resolveMcaApp(mcaService, workspaceService, USER_ADMIN, MCA_ID)

    expect(result.resolved).toBe(true)
    if (result.resolved) {
      expect(result.app.appId).toBe("app_ws_a")
    }
  })

  it("(2) D-03 order: own preferred over workspace preferred over system", async () => {
    // All three tiers have a match → own wins.
    const all = makeMcaService({
      [USER_ADMIN]: [OWN_APP],
      [WS_A]: [WS_A_APP],
      system: [SYSTEM_APP],
    })
    const { workspaceService } = makeWorkspaceService([makeWorkspace(WS_A)])
    const ownFirst = await resolveMcaApp(all.mcaService, workspaceService, USER_ADMIN, MCA_ID)
    expect(ownFirst.resolved && ownFirst.app.appId).toBe("app_own")

    // No own → workspace wins over system.
    const noOwn = makeMcaService({ [USER_ADMIN]: [], [WS_A]: [WS_A_APP], system: [SYSTEM_APP] })
    const wsWins = await resolveMcaApp(noOwn.mcaService, workspaceService, USER_ADMIN, MCA_ID)
    expect(wsWins.resolved && wsWins.app.appId).toBe("app_ws_a")

    // No own, no workspace match → system wins.
    const sysOnly = makeMcaService({ [USER_ADMIN]: [], [WS_A]: [], system: [SYSTEM_APP] })
    const sysWins = await resolveMcaApp(sysOnly.mcaService, workspaceService, USER_ADMIN, MCA_ID)
    expect(sysWins.resolved && sysWins.app.appId).toBe("app_sys")
  })

  it("(2b) within the workspace tier the smallest workspaceId wins regardless of listUserWorkspaces order", async () => {
    const { mcaService } = makeMcaService({
      [USER_ADMIN]: [],
      [WS_A]: [WS_A_APP],
      [WS_B]: [WS_B_APP],
      system: [],
    })
    // listUserWorkspaces is an unsorted find().toArray() — feed the workspaces in
    // REVERSED order to prove the resolver sorts by workspaceId (D-04) instead of
    // trusting Mongo's enumeration order. WS_A ("work_a" < "work_b") must still win.
    const { workspaceService } = makeWorkspaceService([makeWorkspace(WS_B), makeWorkspace(WS_A)])

    const result = await resolveMcaApp(mcaService, workspaceService, USER_ADMIN, MCA_ID)

    expect(result.resolved).toBe(true)
    if (result.resolved) {
      expect(result.app.appId).toBe("app_ws_a")
    }
  })

  it("(3) D-01: no match in own, any workspace, or system → not-installed (no throw)", async () => {
    const { mcaService } = makeMcaService({ [USER_ADMIN]: [], [WS_A]: [], system: [] })
    const { workspaceService } = makeWorkspaceService([makeWorkspace(WS_A)])

    const result = await resolveMcaApp(mcaService, workspaceService, USER_ADMIN, "does-not-exist")

    expect(result.resolved).toBe(false)
    if (!result.resolved) {
      expect(result.reason).toBe(NOT_INSTALLED_REASON)
    }
  })

  it("(4) D-02 scope: queries ONLY the admin's own id, their workspace ids, and system — never arbitrary", async () => {
    const { mcaService, listAppsByOwner } = makeMcaService({
      [USER_ADMIN]: [],
      [WS_A]: [WS_A_APP],
      system: [],
    })
    const { workspaceService, listUserWorkspaces } = makeWorkspaceService([makeWorkspace(WS_A)])

    await resolveMcaApp(mcaService, workspaceService, USER_ADMIN, MCA_ID)

    // The admin's own workspaces were queried via listUserWorkspaces(userId).
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1)
    expect(listUserWorkspaces.mock.calls[0][0]).toBe(USER_ADMIN)

    // listAppsByOwner is only ever called with the admin's userId, their workspace
    // ids, or "system" — never any other/arbitrary owner (no cross-tenant bleed).
    const calledOwnerIds = listAppsByOwner.mock.calls.map((c) => c[0])
    const allowed = new Set([USER_ADMIN, WS_A, "system"])
    for (const ownerId of calledOwnerIds) {
      expect(allowed.has(ownerId)).toBe(true)
    }
  })

  it("(5) workspaceService null → workspace tier skipped (own + system only)", async () => {
    const { mcaService, listAppsByOwner } = makeMcaService({
      [USER_ADMIN]: [],
      system: [SYSTEM_APP],
    })

    const result = await resolveMcaApp(mcaService, null, USER_ADMIN, MCA_ID)

    expect(result.resolved && result.app.appId).toBe("app_sys")
    const calledOwnerIds = listAppsByOwner.mock.calls.map((c) => c[0])
    // Only the admin's own id and system — the workspace tier is skipped entirely.
    for (const ownerId of calledOwnerIds) {
      expect([USER_ADMIN, "system"]).toContain(ownerId)
    }
  })
})
