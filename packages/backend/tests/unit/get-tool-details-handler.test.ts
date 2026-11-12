/**
 * Unit tests — app.get-tool-details.
 *
 * Proves the read-path contract for the permission-approval detail fetch:
 *   - Access matrix: owner allowed, `system` app allowed, workspace member
 *     allowed, non-member ACCESS_DENIED.
 *   - mcaId is derived from the app record, never from the request payload
 *     (engineering principle 6 — no cross-workspace leakage).
 *   - Fail fast: missing appId / empty toolNames / absent McaManager all throw.
 *   - Only the requested tools are returned; namespaced names resolve by suffix.
 *   - A tool with a broken inputSchema is skipped, the rest still return.
 *
 * No real MongoDB — every collaborator is a mock so denial paths can assert the
 * protected source was never touched.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createGetToolDetailsHandler } from "../../src/handlers/domains/app/get-tool-details"

const USER_OWNER = "user_owner"
const USER_MEMBER = "user_member"
const USER_STRANGER = "user_stranger"
const APP_ID = "app_1"
const MCA_ID = "mca.example"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

function makeMcaService(app: Record<string, unknown> | null, catalogEntry: unknown | null = null) {
  // MUW-REQ-13: apps carry a scope since v2.2; these fixtures are shared apps
  // (visible to every member), the access question here is workspace membership.
  const fixture = app ? { scope: 'shared', ...app } : null
  const getApp = mock(async () => fixture)
  const getMcaFromCatalog = mock(async () => catalogEntry)
  const isAppVisibleTo = (a: { scope?: string; installedBy?: string }, userId: string) =>
    a.scope === 'shared' || a.installedBy === userId
  return { mcaService: { getApp, getMcaFromCatalog, isAppVisibleTo } as any, getApp, getMcaFromCatalog }
}

function makeWorkspaceService(allowed: boolean) {
  const canAccess = mock(async () => allowed)
  return { workspaceService: { canAccess } as any, canAccess }
}

function makeMcaManager(staticTools: unknown[]) {
  const getStaticToolsForMca = mock(() => staticTools)
  return { mcaManager: { getStaticToolsForMca } as any, getStaticToolsForMca }
}

const TOOL_SHARE = {
  name: "share-file",
  description: "Grant another account access to a Drive file.",
  inputSchema: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "Target file." },
      role: { type: "string", enum: ["reader", "writer"], description: "Access level." },
    },
    required: ["fileId", "role"],
  },
  annotations: { destructiveHint: true, openWorldHint: true },
}

const TOOL_LIST = {
  name: "list-files",
  description: "List files.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
}

describe("app.get-tool-details handler", () => {
  it("(1) returns only the requested tools for the app owner", async () => {
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([TOOL_SHARE, TOOL_LIST])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), { appId: APP_ID, toolNames: ["share-file"] })

    expect(result).toEqual({
      appId: APP_ID,
      mcaId: MCA_ID,
      tools: [
        {
          requestedName: "share-file",
          name: "share-file",
          description: "Grant another account access to a Drive file.",
          parameters: TOOL_SHARE.inputSchema,
          annotations: TOOL_SHARE.annotations,
        },
      ],
    })
  })

  it("(2) resolves a namespaced tool name by suffix and echoes requestedName", async () => {
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([TOOL_SHARE])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), {
      appId: APP_ID,
      toolNames: ["mydrive_share-file"],
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].requestedName).toBe("mydrive_share-file")
    expect(result.tools[0].name).toBe("share-file")
  })

  it("(2b) matches a snake_case tool name against its kebab-cased namespaced form", async () => {
    // convertStaticTools registers `${appName}_${normalizeToolName(name)}`, so
    // mca.monday's `monday_list_boards` reaches the client as
    // `<app>_monday-list-boards`. Matching the raw name would drop all 15 monday
    // tools (and all 15 todoist, all 3 kelify) silently.
    const snakeTool = {
      name: "monday_list_boards",
      description: "List monday.com boards.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    }
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: "mca.monday" })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([snakeTool])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), {
      appId: APP_ID,
      toolNames: ["myboard_monday-list-boards"],
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].requestedName).toBe("myboard_monday-list-boards")
    expect(result.tools[0].name).toBe("monday_list_boards")
  })

  it("(3) allows a system-owned app", async () => {
    const { mcaService } = makeMcaService({ ownerId: "system", mcaId: MCA_ID })
    const { workspaceService, canAccess } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([TOOL_LIST])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_STRANGER), { appId: APP_ID, toolNames: ["list-files"] })

    expect(result.tools).toHaveLength(1)
    expect(canAccess).not.toHaveBeenCalled()
  })

  it("(4) allows a workspace member via canAccess", async () => {
    const { mcaService } = makeMcaService({ ownerId: "ws_team", mcaId: MCA_ID })
    const { workspaceService, canAccess } = makeWorkspaceService(true)
    const { mcaManager } = makeMcaManager([TOOL_LIST])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_MEMBER), { appId: APP_ID, toolNames: ["list-files"] })

    expect(result.tools).toHaveLength(1)
    expect(canAccess).toHaveBeenCalledWith("ws_team", USER_MEMBER)
  })

  it("(5) rejects a non-member ACCESS_DENIED and never reads the tool source", async () => {
    const { mcaService } = makeMcaService({ ownerId: "ws_other", mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager, getStaticToolsForMca } = makeMcaManager([TOOL_LIST])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    await expect(
      handler(ctx(USER_STRANGER), { appId: APP_ID, toolNames: ["list-files"] }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" })

    expect(getStaticToolsForMca).not.toHaveBeenCalled()
  })

  it("(6) derives mcaId from the app record and ignores a request-supplied mcaId", async () => {
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager, getStaticToolsForMca } = makeMcaManager([TOOL_LIST])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), {
      appId: APP_ID,
      toolNames: ["list-files"],
      mcaId: "mca.attacker",
    } as never)

    expect(getStaticToolsForMca).toHaveBeenCalledWith(MCA_ID)
    expect(result.mcaId).toBe(MCA_ID)
  })

  it("(7) missing appId → MISSING_APP_ID", async () => {
    const { mcaService } = makeMcaService(null)
    const { workspaceService } = makeWorkspaceService(true)
    const { mcaManager } = makeMcaManager([])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    await expect(handler(ctx(USER_OWNER), { toolNames: ["x"] })).rejects.toMatchObject({
      code: "MISSING_APP_ID",
    })
  })

  it("(8) empty toolNames → MISSING_TOOL_NAMES", async () => {
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(true)
    const { mcaManager } = makeMcaManager([])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    await expect(handler(ctx(USER_OWNER), { appId: APP_ID, toolNames: [] })).rejects.toMatchObject({
      code: "MISSING_TOOL_NAMES",
    })
  })

  it("(9) unknown appId → APP_NOT_FOUND", async () => {
    const { mcaService } = makeMcaService(null)
    const { workspaceService } = makeWorkspaceService(true)
    const { mcaManager } = makeMcaManager([])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    await expect(
      handler(ctx(USER_OWNER), { appId: "nope", toolNames: ["x"] }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" })
  })

  it("(10) absent McaManager throws instead of returning an empty list", async () => {
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(true)
    const handler = createGetToolDetailsHandler(mcaService, null, workspaceService)

    await expect(
      handler(ctx(USER_OWNER), { appId: APP_ID, toolNames: ["x"] }),
    ).rejects.toMatchObject({ code: "MCA_MANAGER_UNAVAILABLE" })
  })

  it("(11) skips a tool with a broken inputSchema and returns the rest", async () => {
    const broken = { name: "broken", description: "d", inputSchema: undefined }
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([broken, TOOL_LIST])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), {
      appId: APP_ID,
      toolNames: ["broken", "list-files"],
    })

    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(["list-files"])
  })

  it("(12) omits annotations when the tool declares none", async () => {
    const bare = { name: "bare", description: "d", inputSchema: { type: "object", properties: {} } }
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([bare])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), { appId: APP_ID, toolNames: ["bare"] })

    expect(result.tools[0]).not.toHaveProperty("annotations")
  })

  it("(13) withholds `_`-prefixed private tools even when named explicitly", async () => {
    // convertStaticTools skips these, so they never reach the LLM or the client.
    // Reading the raw static list here must not reopen that door: the caller can
    // guess the namespaced form, and metadata is still metadata.
    const priv = {
      name: "_health_check",
      description: "internal",
      inputSchema: { type: "object", properties: {} },
    }
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([priv, TOOL_LIST])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), {
      appId: APP_ID,
      // Both the bare name and the normalised namespaced form the client holds.
      toolNames: ["_health_check", "myapp_-health-check", "list-files"],
    })

    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(["list-files"])
  })

  it("(14) response tools carry `parameters`, matching the protocol's field name", async () => {
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID })
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([TOOL_SHARE])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), { appId: APP_ID, toolNames: ["share-file"] })

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].parameters.properties).toBeDefined()
    expect("inputSchema" in result.tools[0]).toBe(false)
  })

  it("[PERMW-AC-2] returns the catalog appName and humanized tool descriptions", async () => {
    const createContact = {
      name: "create-contact",
      description:
        "Create a new HubSpot contact. Returns curated contact shape. Params: email, firstname.",
      inputSchema: { type: "object", properties: { email: { type: "string" } } },
    }
    const { mcaService, getMcaFromCatalog } = makeMcaService(
      { ownerId: USER_OWNER, mcaId: "mca.hubspot", name: "hubspot-instance" },
      { mcaId: "mca.hubspot", name: "HubSpot" },
    )
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([createContact])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), {
      appId: APP_ID,
      toolNames: ["hubspot_create-contact"],
    })

    expect(getMcaFromCatalog).toHaveBeenCalledWith("mca.hubspot")
    expect(result.appName).toBe("HubSpot")
    expect(result.mcaId).toBe("mca.hubspot")
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].description).toBe("Create a new HubSpot contact.")
  })

  it("[PERMW-AC-2] omits appName when the catalog has no entry for the app", async () => {
    const { mcaService } = makeMcaService({ ownerId: USER_OWNER, mcaId: MCA_ID }, null)
    const { workspaceService } = makeWorkspaceService(false)
    const { mcaManager } = makeMcaManager([TOOL_SHARE])
    const handler = createGetToolDetailsHandler(mcaService, mcaManager, workspaceService)

    const result = await handler(ctx(USER_OWNER), { appId: APP_ID, toolNames: ["share-file"] })

    expect("appName" in result).toBe(false)
  })
})
