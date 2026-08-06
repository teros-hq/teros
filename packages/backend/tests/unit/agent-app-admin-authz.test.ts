/**
 * Unit tests — authz gates on agent/app handlers that previously operated by id
 * with NO authorization check (TER-513).
 *
 * Two classes of gate:
 *
 *   1. System-admin gate (`requireSystemAdmin`):
 *        - agent.update-core   (createUpdateCoreHandler)
 *        - app.update-mca      (createUpdateMcaHandler)
 *        - app.list-all-mcas   (createListAllMcasHandler)
 *      A non-admin caller must be rejected with FORBIDDEN and the underlying
 *      service operation must NOT run.
 *
 *   2. Agent-access gate (`canAccessAgent`):
 *        - agent.get-apps      (createGetAppsHandler)
 *        - agent.list-providers(createListProvidersHandler)
 *      A caller without access to the target agent must be rejected with
 *      FORBIDDEN and the underlying read must NOT run.
 *
 * No real MongoDB — Db and the services are mocked. The denied-case tests are
 * designed to MORDER: they assert the protected operation was never invoked.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createGetAppsHandler } from "../../src/handlers/domains/agent/get-apps"
import { createListProvidersHandler } from "../../src/handlers/domains/agent/list-providers"
import { createUpdateCoreHandler } from "../../src/handlers/domains/agent/update-core"
import { createListAllMcasHandler } from "../../src/handlers/domains/app/list-all-mcas"
import { createUpdateMcaHandler } from "../../src/handlers/domains/app/update-mca"
import type { McaService } from "../../src/services/mca-service"
import type { ModelService } from "../../src/services/model-service"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ADMIN = "user_admin"
const USER_PLAIN = "user_plain"
const WORKSPACE_BOB = "work_bob"
const AGENT_OWNED = "agent_owned" // global agent owned by USER_PLAIN
const AGENT_FOREIGN = "agent_foreign" // workspace agent USER_PLAIN cannot reach
const CORE_ID = "core_test_001"
const MCP_ID = "mca.test"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

// ---------------------------------------------------------------------------
// Mock Db
//
//   users:
//     USER_ADMIN → { role: 'admin' }
//     USER_PLAIN → { role: 'user' }
//   agents:
//     AGENT_OWNED   → global agent owned by USER_PLAIN (no workspaceId)
//     AGENT_FOREIGN → agent in WORKSPACE_BOB (not owned/joined by USER_PLAIN)
//   workspaces:
//     WORKSPACE_BOB → owned by some other user
//   workspace_members: empty (no cross-workspace membership)
// ---------------------------------------------------------------------------

function makeDb() {
  // Memoized so the same collection mock (and its call counts) is returned
  // across repeated `db.collection(name)` calls within a single handler run.
  const collections: Record<string, any> = {
    users: {
      findOne: mock(async (filter: any) => {
        if (filter.userId === USER_ADMIN) return { userId: USER_ADMIN, role: "admin" }
        if (filter.userId === USER_PLAIN) return { userId: USER_PLAIN, role: "user" }
        return null
      }),
    },
    agents: {
      findOne: mock(async (filter: any) => {
        if (filter.agentId === AGENT_OWNED) {
          return { agentId: AGENT_OWNED, ownerId: USER_PLAIN, availableProviders: [] }
        }
        if (filter.agentId === AGENT_FOREIGN) {
          return { agentId: AGENT_FOREIGN, workspaceId: WORKSPACE_BOB, availableProviders: [] }
        }
        return null
      }),
    },
    workspaces: {
      findOne: mock(async (filter: any) => {
        if (filter.workspaceId === WORKSPACE_BOB) {
          return { workspaceId: WORKSPACE_BOB, ownerId: "user_other", status: 'active' }
        }
        return null
      }),
    },
    workspace_members: {
      findOne: mock(async () => null),
      find: mock(() => ({ toArray: mock(async () => []) })),
    },
    user_providers: {
      find: mock(() => ({ toArray: mock(async () => []) })),
    },
  }
  return {
    collection: mock((name: string) => collections[name] ?? { findOne: mock(async () => null) }),
  } as any
}

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

function makeModelService(overrides: Partial<ModelService> = {}): ModelService {
  return {
    updateAgentCore: mock(async () => ({
      coreId: CORE_ID,
      name: "Test",
      fullName: "Test Core",
      version: 1,
      systemPrompt: "sp",
      personality: {},
      capabilities: [],
      avatarUrl: null,
      modelId: "m",
      modelOverrides: {},
      status: "active",
    })),
    ...overrides,
  } as any
}

function makeMcaService(overrides: Partial<McaService> = {}): McaService {
  return {
    updateMcaAvailability: mock(async () => ({
      mcaId: MCP_ID,
      name: "Test MCA",
      description: "d",
      icon: "icon.png",
      color: "#000",
      category: "test",
      tools: [],
      status: "active",
      availability: {},
      systemSecrets: [],
      userSecrets: [],
      auth: null,
    })),
    listCatalog: mock(async () => []),
    getAgentApps: mock(async () => ({ agentId: AGENT_OWNED, apps: [] })),
    ...overrides,
  } as any
}

// ===========================================================================
// 1. System-admin gates
// ===========================================================================

describe("agent.update-core handler (admin gate)", () => {
  it("rejects a non-admin caller and never updates the core", async () => {
    const modelService = makeModelService()
    const handler = createUpdateCoreHandler(makeDb(), modelService)

    await expect(
      handler(ctx(USER_PLAIN), { coreId: CORE_ID, updates: { status: "inactive" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    expect(modelService.updateAgentCore).not.toHaveBeenCalled()
  })

  it("allows an admin caller and updates the core", async () => {
    const modelService = makeModelService()
    const handler = createUpdateCoreHandler(makeDb(), modelService)

    const result = await handler(ctx(USER_ADMIN), {
      coreId: CORE_ID,
      updates: { status: "inactive" },
    })

    expect(result).toMatchObject({ core: { coreId: CORE_ID } })
    expect(modelService.updateAgentCore).toHaveBeenCalledWith(CORE_ID, { status: "inactive" })
  })
})

describe("app.update-mca handler (admin gate)", () => {
  it("rejects a non-admin caller and never updates availability", async () => {
    const mcaService = makeMcaService()
    const handler = createUpdateMcaHandler(mcaService, makeDb())

    await expect(
      handler(ctx(USER_PLAIN), { mcpId: MCP_ID, updates: { enabled: false } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    expect(mcaService.updateMcaAvailability).not.toHaveBeenCalled()
  })

  it("allows an admin caller and updates availability", async () => {
    const mcaService = makeMcaService()
    const handler = createUpdateMcaHandler(mcaService, makeDb())

    const result = await handler(ctx(USER_ADMIN), { mcpId: MCP_ID, updates: { enabled: false } })

    expect(result).toMatchObject({ mca: { mcaId: MCP_ID } })
    expect(mcaService.updateMcaAvailability).toHaveBeenCalledWith(MCP_ID, { enabled: false })
  })
})

describe("app.list-all-mcas handler (admin gate)", () => {
  it("rejects a non-admin caller and never reads the catalog", async () => {
    const mcaService = makeMcaService()
    const handler = createListAllMcasHandler(mcaService, makeDb())

    await expect(handler(ctx(USER_PLAIN), {})).rejects.toMatchObject({ code: "FORBIDDEN" })

    expect(mcaService.listCatalog).not.toHaveBeenCalled()
  })

  it("allows an admin caller and reads the catalog", async () => {
    const mcaService = makeMcaService()
    const handler = createListAllMcasHandler(mcaService, makeDb())

    const result = await handler(ctx(USER_ADMIN), {})

    expect(result).toEqual({ mcas: [] })
    expect(mcaService.listCatalog).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// 2. Agent-access gates
// ===========================================================================

describe("agent.get-apps handler (agent-access gate)", () => {
  it("rejects a caller without access to the agent and never reads apps", async () => {
    const mcaService = makeMcaService()
    const handler = createGetAppsHandler(mcaService, makeDb())

    // USER_PLAIN does not own / belong to AGENT_FOREIGN's workspace
    await expect(handler(ctx(USER_PLAIN), { agentId: AGENT_FOREIGN })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })

    expect(mcaService.getAgentApps).not.toHaveBeenCalled()
  })

  it("allows a caller with access to the agent and reads apps", async () => {
    const mcaService = makeMcaService()
    const handler = createGetAppsHandler(mcaService, makeDb())

    // USER_PLAIN owns AGENT_OWNED (global agent)
    const result = await handler(ctx(USER_PLAIN), { agentId: AGENT_OWNED })

    expect(result).toMatchObject({ agentId: AGENT_OWNED, apps: [] })
    expect(mcaService.getAgentApps).toHaveBeenCalledWith(AGENT_OWNED, undefined)
  })
})

describe("agent.list-providers handler (agent-access gate)", () => {
  it("rejects a caller without access to the agent and never reads agent data", async () => {
    const db = makeDb()
    const handler = createListProvidersHandler(db)

    await expect(handler(ctx(USER_PLAIN), { agentId: AGENT_FOREIGN })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })

    // The agents collection must only have been hit by canAccessAgent (1 lookup),
    // never the post-gate `findOne` that reads availableProviders.
    const agentsFindOne = db.collection("agents").findOne
    expect(agentsFindOne).toHaveBeenCalledTimes(1)
  })

  it("allows a caller with access to the agent and returns providers", async () => {
    const handler = createListProvidersHandler(makeDb())

    const result = await handler(ctx(USER_PLAIN), { agentId: AGENT_OWNED })

    expect(result).toMatchObject({ agentId: AGENT_OWNED, availableProviders: [], providers: [] })
  })
})
