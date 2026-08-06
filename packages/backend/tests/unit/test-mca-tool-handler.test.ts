/**
 * Unit tests — app.test-mca-tool + app.get-mca-resolvability (Phase 7, SC1/SC3).
 *
 * Proves the Phase 7 execute-path + resolvability contract:
 *   - Admin gate (D-05, TER-447): a non-admin caller is rejected FORBIDDEN BEFORE
 *     any resolution or execution — mcaManager.executeTool is never invoked on denial.
 *   - Input validation: missing mcaId → INVALID_REQUEST; missing tool → MISSING_TOOL;
 *     null mcaManager → MCA_UNAVAILABLE.
 *   - D-01 not-installed guard: an uninstalled mcaId throws NOT_INSTALLED and the
 *     executor is never called.
 *   - D-03 order: when an app resolves in BOTH own and system, execution targets the
 *     admin's OWN appId; a workspace-owned app resolves when only a workspace has it.
 *   - Happy path: a resolved app runs one tool and returns the typed success shape.
 *   - Resolvability (D-06 consistency): the not-installed reason string is byte-identical
 *     to the shared NOT_INSTALLED_REASON constant the execute handler resolves against.
 *
 * No real MongoDB — Db is mocked like mca-tool-schemas-handler.test.ts. McaService,
 * McaManager, and WorkspaceService are fakes so denial/not-installed cases can assert
 * the executor never ran, and so the revised workspace-scoped D-02 can be exercised.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createTestMcaToolHandler } from "../../src/handlers/domains/app/test-mca-tool"
import { createGetMcaResolvabilityHandler } from "../../src/handlers/domains/app/get-mca-resolvability"
import { NOT_INSTALLED_REASON } from "../../src/handlers/domains/app/mca-app-resolver"

// ---------------------------------------------------------------------------
// Constants + helpers (mirror the Phase 6 analog)
// ---------------------------------------------------------------------------

const USER_ADMIN = "user_admin"
const USER_PLAIN = "user_plain"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

// users mock: USER_ADMIN → admin (passes requireSystemAdmin),
// USER_PLAIN → user (rejected FORBIDDEN).
function makeDb() {
  const collections: Record<string, any> = {
    users: {
      findOne: mock(async (filter: any) => {
        if (filter.userId === USER_ADMIN) return { userId: USER_ADMIN, role: "admin" }
        if (filter.userId === USER_PLAIN) return { userId: USER_PLAIN, role: "user" }
        return null
      }),
    },
  }
  const db = {
    collection: mock((name: string) => collections[name] ?? { findOne: mock(async () => null) }),
  } as any
  return db
}

// A fake McaService whose listAppsByOwner returns fixture apps per ownerId.
// `ownApps` are returned for the admin's own userId; `systemApps` for "system";
// `workspaceApps` keyed by workspaceId for the revised workspace tier.
function makeMcaService(
  ownApps: any[] = [],
  systemApps: any[] = [],
  workspaceApps: Record<string, any[]> = {},
) {
  const listAppsByOwner = mock(async (ownerId: string) => {
    if (ownerId === "system") return systemApps
    if (ownerId in workspaceApps) return workspaceApps[ownerId]
    if (ownerId === USER_ADMIN) return ownApps
    return []
  })
  const mcaService = { listAppsByOwner } as any
  return { mcaService, listAppsByOwner }
}

// A fake WorkspaceService whose listUserWorkspaces returns the admin's workspaces.
// Default: no workspaces (own + system only), preserving legacy tie-break cases.
function makeWorkspaceService(workspaces: any[] = []) {
  const listUserWorkspaces = mock(async (_userId: string) => workspaces)
  const workspaceService = { listUserWorkspaces } as any
  return { workspaceService, listUserWorkspaces }
}

// A fake McaManager whose executeTool is a mock so we can assert it was never
// called on denial / not-installed.
function makeMcaManager(result?: { output: string; isError: boolean; mcaId: string }) {
  const executeTool = mock(async () => result ?? { output: "{}", isError: false, mcaId: "m" })
  const mcaManager = { executeTool } as any
  return { mcaManager, executeTool }
}

function app(over: Partial<Record<string, any>> = {}) {
  return {
    appId: "app_x",
    mcaId: "slack",
    ownerId: "ws_owner",
    name: "slack",
    status: "active",
    ...over,
  }
}

// ===========================================================================

describe("app.test-mca-tool handler", () => {
  it("(1) TER-447: rejects a non-admin caller FORBIDDEN and never runs the executor", async () => {
    const db = makeDb()
    const { mcaService } = makeMcaService([app()], [])
    const { mcaManager, executeTool } = makeMcaManager()
    const handler = createTestMcaToolHandler(mcaService, mcaManager, db)

    await expect(handler(ctx(USER_PLAIN), { mcaId: "slack", tool: "ping" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })

    // TER-447 invariant: the protected execution never runs on denial (D-05).
    expect(executeTool).not.toHaveBeenCalled()
  })

  it("(2) admin + missing mcaId → INVALID_REQUEST; missing tool → MISSING_TOOL", async () => {
    const db = makeDb()
    const { mcaService } = makeMcaService([app()], [])
    const { mcaManager } = makeMcaManager()
    const handler = createTestMcaToolHandler(mcaService, mcaManager, db)

    await expect(handler(ctx(USER_ADMIN), { tool: "ping" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    await expect(handler(ctx(USER_ADMIN), { mcaId: "slack" })).rejects.toMatchObject({
      code: "MISSING_TOOL",
    })
  })

  it("(2b) admin + null mcaManager → MCA_UNAVAILABLE", async () => {
    const db = makeDb()
    const { mcaService } = makeMcaService([app()], [])
    const handler = createTestMcaToolHandler(mcaService, null, db)

    await expect(handler(ctx(USER_ADMIN), { mcaId: "slack", tool: "ping" })).rejects.toMatchObject({
      code: "MCA_UNAVAILABLE",
    })
  })

  it("(3) D-01: uninstalled mcaId → NOT_INSTALLED and the executor is never called", async () => {
    const db = makeDb()
    // No fixture app anywhere → resolver returns not-installed.
    const { mcaService } = makeMcaService([], [])
    const { mcaManager, executeTool } = makeMcaManager()
    const handler = createTestMcaToolHandler(mcaService, mcaManager, db)

    await expect(handler(ctx(USER_ADMIN), { mcaId: "ghost", tool: "ping" })).rejects.toMatchObject({
      code: "NOT_INSTALLED",
    })
    expect(executeTool).not.toHaveBeenCalled()
  })

  it("(4) D-03 order: app in BOTH own and system → executeTool targets the OWN appId", async () => {
    const db = makeDb()
    const ownApp = app({ appId: "app_own", ownerId: "ws_admin", name: "slack" })
    const sysApp = app({ appId: "app_system", ownerId: "system", name: "slack" })
    const { mcaService } = makeMcaService([ownApp], [sysApp])
    const { mcaManager, executeTool } = makeMcaManager({
      output: JSON.stringify({ ok: true }),
      isError: false,
      mcaId: "slack",
    })
    const handler = createTestMcaToolHandler(mcaService, mcaManager, db)

    await handler(ctx(USER_ADMIN), { mcaId: "slack", tool: "ping" })

    expect(executeTool).toHaveBeenCalledTimes(1)
    const callArgs = executeTool.mock.calls[0]
    // ctx object is the 3rd arg: { appId, userId, workspaceId }
    expect(callArgs[2]).toMatchObject({ appId: "app_own" })
  })

  it("(4b) revised D-02: workspace-owned app in the admin's workspace resolves and runs", async () => {
    const db = makeDb()
    const wsApp = app({
      appId: "app_ws",
      mcaId: "memory",
      ownerId: "work_admin",
      ownerType: "workspace",
      name: "memory",
    })
    // No own, no system — only a workspace the admin owns has the app.
    const { mcaService } = makeMcaService([], [], { work_admin: [wsApp] })
    const { workspaceService } = makeWorkspaceService([{ workspaceId: "work_admin" }])
    const { mcaManager, executeTool } = makeMcaManager({
      output: JSON.stringify({ ok: true }),
      isError: false,
      mcaId: "memory",
    })
    const handler = createTestMcaToolHandler(mcaService, mcaManager, db, workspaceService)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "memory", tool: "health" })) as {
      appId: string
      success: boolean
    }

    expect(result.appId).toBe("app_ws")
    expect(result.success).toBe(true)
    // Executes against the workspace scope (workspaceId === the workspace's ownerId),
    // with a deterministic user-scoped synthetic TEST agentId so agent-scoped MCAs
    // (memory) operate against a diagnostic namespace instead of throwing.
    expect(executeTool).toHaveBeenCalledWith(
      "memory_health",
      {},
      {
        appId: "app_ws",
        agentId: `test-agent:${USER_ADMIN}`,
        channelId: `test-channel:${USER_ADMIN}`,
        userId: USER_ADMIN,
        workspaceId: "work_admin",
      },
    )
  })

  it("(5) happy path: resolved app runs one tool → { mcaId, tool, appId, success, result }", async () => {
    const db = makeDb()
    const resolvedApp = app({ appId: "app_x", ownerId: "ws_owner", name: "slack" })
    const { mcaService } = makeMcaService([resolvedApp], [])
    const { mcaManager, executeTool } = makeMcaManager({
      output: JSON.stringify({ ok: true }),
      isError: false,
      mcaId: "slack",
    })
    const handler = createTestMcaToolHandler(mcaService, mcaManager, db)

    const result = (await handler(ctx(USER_ADMIN), {
      mcaId: "slack",
      tool: "ping",
      input: { a: 1 },
    })) as {
      mcaId: string
      tool: string
      appId: string
      success: boolean
      result: unknown
    }

    expect(result).toEqual({
      mcaId: "slack",
      tool: "ping",
      appId: "app_x",
      success: true,
      result: { ok: true },
    })
    // fullToolName is `${resolved.name}_${tool}` with a synthetic user-scoped TEST
    // agentId alongside { appId, userId, workspaceId: ownerId }.
    expect(executeTool).toHaveBeenCalledWith(
      "slack_ping",
      { a: 1 },
      {
        appId: "app_x",
        agentId: `test-agent:${USER_ADMIN}`,
        channelId: `test-channel:${USER_ADMIN}`,
        userId: USER_ADMIN,
        workspaceId: "ws_owner",
      },
    )
  })

  it("(5b) snake_case tool is kebab-cased to match the registered mapping key", async () => {
    // convertStaticTools registers the key as `${appName}_${tool.replace(/_/g,'-')}`.
    // A raw snake_case tool (monday_create_board, kelify_send_message, …) would miss
    // that key → false "Tool mapping not found". The handler must kebab-case the tool
    // part so executeTool receives the SAME key that was registered.
    const db = makeDb()
    const resolvedApp = app({ appId: "app_m", ownerId: "ws_owner", name: "monday", mcaId: "monday" })
    const { mcaService } = makeMcaService([resolvedApp], [])
    const { mcaManager, executeTool } = makeMcaManager({
      output: JSON.stringify({ ok: true }),
      isError: false,
      mcaId: "monday",
    })
    const handler = createTestMcaToolHandler(mcaService, mcaManager, db)

    const result = (await handler(ctx(USER_ADMIN), {
      mcaId: "monday",
      tool: "monday_create_board",
    })) as { tool: string; success: boolean }

    // Lookup key is kebab-cased on the tool part only (appName keeps its `_` separator).
    expect(executeTool.mock.calls[0][0]).toBe("monday_monday-create-board")
    // The response still echoes the ORIGINAL (raw) tool name the caller passed.
    expect(result.tool).toBe("monday_create_board")
    expect(result.success).toBe(true)
  })
})

describe("app.get-mca-resolvability handler", () => {
  it("(6) TER-447: rejects a non-admin caller FORBIDDEN before any resolution", async () => {
    const db = makeDb()
    const { mcaService, listAppsByOwner } = makeMcaService([app()], [])
    const handler = createGetMcaResolvabilityHandler(mcaService, db)

    await expect(handler(ctx(USER_PLAIN), { mcaId: "slack" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(listAppsByOwner).not.toHaveBeenCalled()
  })

  it("(6b) admin + missing mcaId → INVALID_REQUEST", async () => {
    const db = makeDb()
    const { mcaService } = makeMcaService([app()], [])
    const handler = createGetMcaResolvabilityHandler(mcaService, db)

    await expect(handler(ctx(USER_ADMIN), {})).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
  })

  it("(7) uninstalled mcaId → { runnable:false, reason } equal to the shared NOT_INSTALLED_REASON", async () => {
    const db = makeDb()
    const { mcaService } = makeMcaService([], [])
    const handler = createGetMcaResolvabilityHandler(mcaService, db)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "ghost" })) as {
      runnable: boolean
      reason: string
    }

    expect(result.runnable).toBe(false)
    // D-06 wire-shape consistency: same constant the execute handler resolves against.
    expect(result.reason).toBe(NOT_INSTALLED_REASON)
  })

  it("(8) resolved app → { runnable: true, appId }", async () => {
    const db = makeDb()
    const resolvedApp = app({ appId: "app_x", ownerId: "ws_owner", name: "slack" })
    const { mcaService } = makeMcaService([resolvedApp], [])
    const handler = createGetMcaResolvabilityHandler(mcaService, db)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "slack" })) as {
      runnable: boolean
      appId: string
    }

    expect(result.runnable).toBe(true)
    expect(result.appId).toBe("app_x")
  })

  it("(9) revised D-02: workspace-owned app → { runnable: true, appId } via the workspace tier", async () => {
    const db = makeDb()
    const wsApp = app({
      appId: "app_ws",
      mcaId: "memory",
      ownerId: "work_admin",
      ownerType: "workspace",
      name: "memory",
    })
    const { mcaService } = makeMcaService([], [], { work_admin: [wsApp] })
    const { workspaceService } = makeWorkspaceService([{ workspaceId: "work_admin" }])
    const handler = createGetMcaResolvabilityHandler(mcaService, db, workspaceService)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "memory" })) as {
      runnable: boolean
      appId: string
    }

    expect(result.runnable).toBe(true)
    expect(result.appId).toBe("app_ws")
  })
})
