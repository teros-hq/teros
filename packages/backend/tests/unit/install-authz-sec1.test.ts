/**
 * SEC-1 (TER-720) regression tests — install/grant authorization.
 *
 * B-4: the availability gate (`enabled` / `role`) was enforced on `app.install`
 * but NOT on the parallel `workspace.install-app → createWorkspaceApp` path, so
 * any user could install a disabled/admin-only MCA (e.g. mca.teros.docker-env,
 * which mounts the Docker socket) into their own workspace → host root.
 *
 * A1: `app.grant-access` / `app.revoke-access` had NO authorization — any user
 * could grant their agent access to another tenant's app, or revoke another
 * tenant's grants.
 *
 * These tests MORDER: the denied cases assert the protected write (insertOne /
 * grantAccess / revokeAccess) is NEVER reached. No real MongoDB.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createGrantAccessHandler } from "../../src/handlers/domains/app/grant-access"
import { createRevokeAccessHandler } from "../../src/handlers/domains/app/revoke-access"
import { McaService } from "../../src/services/mca-service"

const USER_PLAIN = "user_plain"
const WORKSPACE = "work_1"
const WORKSPACE_OWNER = "user_wsowner"
const OTHER_MEMBER = "user_member2"
const STRANGER = "user_stranger"
const OTHER_WORKSPACE = "work_2"
const AGENT_OWNED = "agent_owned"
const AGENT_FOREIGN = "agent_foreign"
const APP = "app_1"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

// Build a McaService instance without running the constructor, then stub only
// the collaborators the method under test touches.
function makeService(overrides: Record<string, unknown> = {}): any {
  const insertOne = mock(async () => ({}))
  // findOne backs the TER-528 single-install dedup check in createWorkspaceApp
  // (landed on dev after this test was written) — null means "not installed
  // yet". Harmless no-op today if TER-528 isn't in this branch's base yet;
  // keeps this test green once rebased onto current dev.
  const findOne = mock(async () => null)
  const svc: any = Object.create(McaService.prototype)
  svc.appsCollection = { insertOne, findOne }
  svc.workspaceService = {
    canWrite: mock(async () => true),
    getWorkspace: mock(async () => ({ workspaceId: WORKSPACE, volumeId: "vol_1" })),
    canAccess: mock(async () => true),
  }
  svc.getMcaFromCatalog = mock(async () => ({ mcaId: "mca.x", availability: {} }))
  svc.getUserRole = mock(async () => ({ role: "user" }))
  svc.generateDefaultAppName = mock(async () => "x")
  svc.validateAppName = mock(() => ({ valid: true }))
  svc.isAppNameAvailable = mock(async () => true)
  svc._insertOne = insertOne
  Object.assign(svc, overrides)
  return svc
}

// ===========================================================================
// B-4 — createWorkspaceApp enforces the availability gate
// ===========================================================================

describe("createWorkspaceApp availability gate (B-4)", () => {
  it("rejects a DISABLED MCA and never inserts the app", async () => {
    const svc = makeService({
      getMcaFromCatalog: mock(async () => ({
        mcaId: "mca.teros.docker-env",
        availability: { enabled: false },
      })),
    })

    await expect(
      svc.createWorkspaceApp(WORKSPACE, "mca.teros.docker-env", "", USER_PLAIN, {}),
    ).rejects.toThrow(/not available/)

    expect(svc._insertOne).not.toHaveBeenCalled()
  })

  it("rejects an ADMIN-only MCA for a plain user and never inserts the app", async () => {
    const svc = makeService({
      getMcaFromCatalog: mock(async () => ({
        mcaId: "mca.teros.admin.bash",
        availability: { role: "admin" },
      })),
      getUserRole: mock(async () => ({ role: "user" })),
    })

    await expect(
      svc.createWorkspaceApp(WORKSPACE, "mca.teros.admin.bash", "", USER_PLAIN, {}),
    ).rejects.toThrow(/requires admin role/)

    expect(svc._insertOne).not.toHaveBeenCalled()
  })

  it("allows an ordinary MCA and inserts the app", async () => {
    const svc = makeService()

    const app = await svc.createWorkspaceApp(WORKSPACE, "mca.x", "", USER_PLAIN, {})

    expect(app).toMatchObject({
      mcaId: "mca.x",
      ownerId: WORKSPACE,
      ownerType: "workspace",
      status: "active",
    })
    expect(svc._insertOne).toHaveBeenCalledTimes(1)
  })

  it("allows an admin-only MCA for an admin user", async () => {
    const svc = makeService({
      getMcaFromCatalog: mock(async () => ({
        mcaId: "mca.teros.admin.bash",
        availability: { role: "admin" },
      })),
      getUserRole: mock(async () => ({ role: "admin" })),
    })

    await svc.createWorkspaceApp(WORKSPACE, "mca.teros.admin.bash", "", "user_admin", {})

    expect(svc._insertOne).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// A1 — canManageAppAccess decision + grant/revoke handler gates
// ===========================================================================

type SeedAgent = { agentId: string; workspaceId: string | null; ownerId: string }

// Faithful evaluator of the exact filter the gate builds ({ agentId, $or: [...] })
// against seeded agents — so these tests bite the roster logic, not a stub's
// hardcoded return. An owner-only gate fails the first (R1) case below.
function matchesRoster(agent: SeedAgent, filter: any): boolean {
  if (agent.agentId !== filter.agentId) return false
  return (filter.$or as any[]).some((clause) => {
    if (typeof clause.workspaceId === "string") {
      return agent.workspaceId === clause.workspaceId // { workspaceId }
    }
    // superagent clause: { ownerId: { $in }, workspaceId: { $in: [null, undefined] } }
    const ownerOk = clause.ownerId?.$in?.includes(agent.ownerId)
    const wsOk = clause.workspaceId?.$in?.includes(agent.workspaceId ?? null)
    return Boolean(ownerOk && wsOk)
  })
}

function makeAccessService(
  opts: {
    agents?: SeedAgent[]
    ownerType?: string
    appWorkspaceId?: string
    workspaceOwnerId?: string
    canAccess?: boolean
  } = {},
): any {
  const {
    agents = [],
    ownerType = "workspace",
    appWorkspaceId = WORKSPACE,
    workspaceOwnerId = WORKSPACE_OWNER,
    canAccess = true,
  } = opts
  const svc: any = Object.create(McaService.prototype)
  svc.getApp = mock(async () => ({ appId: APP, ownerId: appWorkspaceId, ownerType }))
  svc.workspaceService = { canAccess: mock(async () => canAccess) }
  svc.db = {
    collection: mock((name: string) => {
      if (name === "workspaces") {
        return {
          findOne: mock(async () => ({ workspaceId: appWorkspaceId, ownerId: workspaceOwnerId })),
        }
      }
      return {
        findOne: mock(async (filter: any) => agents.find((a) => matchesRoster(a, filter)) ?? null),
      }
    }),
  }
  return svc
}

describe("canManageAppAccess decision (A1 + R1 shared-workspace roster)", () => {
  it("returns TRUE for a workspace agent the caller does NOT personally own (R1 fix)", async () => {
    // The AppWindow offers a toggle for every workspace agent; an owner-only
    // gate returned false here and broke shared-workspace access management.
    const svc = makeAccessService({
      agents: [{ agentId: AGENT_FOREIGN, workspaceId: WORKSPACE, ownerId: OTHER_MEMBER }],
    })
    expect(await svc.canManageAppAccess(USER_PLAIN, AGENT_FOREIGN, APP)).toBe(true)
  })

  it("returns TRUE for a superagent owned by the workspace owner", async () => {
    const svc = makeAccessService({
      agents: [{ agentId: AGENT_OWNED, workspaceId: null, ownerId: WORKSPACE_OWNER }],
    })
    expect(await svc.canManageAppAccess(USER_PLAIN, AGENT_OWNED, APP)).toBe(true)
  })

  it("returns FALSE when the caller is NOT a member of the app's workspace (cross-tenant BOLA)", async () => {
    const svc = makeAccessService({
      agents: [{ agentId: AGENT_OWNED, workspaceId: WORKSPACE, ownerId: USER_PLAIN }],
      canAccess: false,
    })
    expect(await svc.canManageAppAccess(USER_PLAIN, AGENT_OWNED, APP)).toBe(false)
  })

  it("returns FALSE for an agent scoped to a DIFFERENT workspace", async () => {
    const svc = makeAccessService({
      agents: [{ agentId: AGENT_FOREIGN, workspaceId: OTHER_WORKSPACE, ownerId: USER_PLAIN }],
    })
    expect(await svc.canManageAppAccess(USER_PLAIN, AGENT_FOREIGN, APP)).toBe(false)
  })

  it("returns FALSE for a superagent owned by a stranger (not caller or workspace owner)", async () => {
    const svc = makeAccessService({
      agents: [{ agentId: AGENT_FOREIGN, workspaceId: null, ownerId: STRANGER }],
    })
    expect(await svc.canManageAppAccess(USER_PLAIN, AGENT_FOREIGN, APP)).toBe(false)
  })

  it("returns FALSE when the agent is not found in the workspace roster", async () => {
    const svc = makeAccessService({ agents: [] })
    expect(await svc.canManageAppAccess(USER_PLAIN, AGENT_OWNED, APP)).toBe(false)
  })

  it("returns FALSE when the app is not workspace-scoped", async () => {
    const svc = makeAccessService({
      ownerType: "user",
      agents: [{ agentId: AGENT_OWNED, workspaceId: WORKSPACE, ownerId: USER_PLAIN }],
    })
    expect(await svc.canManageAppAccess(USER_PLAIN, AGENT_OWNED, APP)).toBe(false)
  })
})

describe("app.grant-access handler gate (A1)", () => {
  it("rejects when canManageAppAccess is false and never grants", async () => {
    const mcaService: any = {
      canManageAppAccess: mock(async () => false),
      grantAccess: mock(async () => {}),
    }
    const handler = createGrantAccessHandler(mcaService)

    await expect(
      handler(ctx(USER_PLAIN), { agentId: AGENT_FOREIGN, appId: APP }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" })

    expect(mcaService.grantAccess).not.toHaveBeenCalled()
  })

  it("grants when authorized", async () => {
    const mcaService: any = {
      canManageAppAccess: mock(async () => true),
      grantAccess: mock(async () => {}),
    }
    const handler = createGrantAccessHandler(mcaService)

    const result = await handler(ctx(USER_PLAIN), { agentId: AGENT_OWNED, appId: APP })

    expect(result).toMatchObject({ agentId: AGENT_OWNED, appId: APP, success: true })
    expect(mcaService.grantAccess).toHaveBeenCalledWith({
      agentId: AGENT_OWNED,
      appId: APP,
      grantedBy: USER_PLAIN,
    })
  })
})

describe("app.revoke-access handler gate (A1)", () => {
  it("rejects when canManageAppAccess is false and never revokes", async () => {
    const mcaService: any = {
      canManageAppAccess: mock(async () => false),
      revokeAccess: mock(async () => true),
    }
    const handler = createRevokeAccessHandler(mcaService)

    await expect(
      handler(ctx(USER_PLAIN), { agentId: AGENT_FOREIGN, appId: APP }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" })

    expect(mcaService.revokeAccess).not.toHaveBeenCalled()
  })

  it("revokes when authorized", async () => {
    const mcaService: any = {
      canManageAppAccess: mock(async () => true),
      revokeAccess: mock(async () => true),
    }
    const handler = createRevokeAccessHandler(mcaService)

    const result = await handler(ctx(USER_PLAIN), { agentId: AGENT_OWNED, appId: APP })

    expect(result).toMatchObject({ agentId: AGENT_OWNED, appId: APP, success: true })
    expect(mcaService.revokeAccess).toHaveBeenCalledWith(AGENT_OWNED, APP)
  })
})
