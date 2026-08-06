/**
 * Unit tests — app.get-mca-tool-schemas (Phase 6, SC1-SC3 / D-01 / D-02 / D-04).
 *
 * Proves the Phase 6 read-path contract:
 *   - Admin gate (D-04, TER-447): a non-admin caller is rejected FORBIDDEN BEFORE
 *     any schema read — the getStaticToolsForMca source is never invoked on denial.
 *   - Missing mcaId → INVALID_REQUEST.
 *   - SC1/D-02: known mcaId → { tools: [{ tool, inputSchema, requiresInput }] } with
 *     inputSchema returned verbatim (type/properties/required/descriptions/enums preserved).
 *   - SC3/D-01: zero properties → requiresInput false; any property (even only-optional)
 *     → requiresInput true.
 *   - Discretion defaults: unknown/absent mcaId → { tools: [] } (no throw);
 *     a tool missing inputSchema.properties is skipped, the rest still returned.
 *
 * No real MongoDB — Db is mocked like mca-health-handlers.test.ts. The mcaManager
 * source is a mock so the denied case can assert it was never called.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createGetMcaToolSchemasHandler } from "../../src/handlers/domains/app/get-mca-tool-schemas"

// ---------------------------------------------------------------------------
// Constants + helpers (mirror the Phase 5 analog)
// ---------------------------------------------------------------------------

const USER_ADMIN = "user_admin"
const USER_PLAIN = "user_plain"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

// users mock copied from makeDb: USER_ADMIN → admin (passes requireSystemAdmin),
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

// A fake McaManager exposing only getStaticToolsForMca (mockable/settable per test).
function makeMcaManager(staticTools: unknown[] = []) {
  const getStaticToolsForMca = mock(() => staticTools)
  const mcaManager = { getStaticToolsForMca } as any
  return { mcaManager, getStaticToolsForMca }
}

// ===========================================================================

describe("app.get-mca-tool-schemas handler", () => {
  it("(1) rejects a non-admin caller FORBIDDEN and never reads the schema source", async () => {
    const db = makeDb()
    const { mcaManager, getStaticToolsForMca } = makeMcaManager([])
    const handler = createGetMcaToolSchemasHandler(mcaManager, db)

    await expect(handler(ctx(USER_PLAIN), { mcaId: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })

    // TER-447 invariant: the protected read never runs on denial.
    expect(getStaticToolsForMca).not.toHaveBeenCalled()
  })

  it("(2) admin caller with missing mcaId → INVALID_REQUEST", async () => {
    const db = makeDb()
    const { mcaManager } = makeMcaManager([])
    const handler = createGetMcaToolSchemasHandler(mcaManager, db)

    await expect(handler(ctx(USER_ADMIN), {})).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
  })

  it("(3) SC1/D-02: known mcaId returns { tools:[{tool,inputSchema,requiresInput}] } with inputSchema verbatim", async () => {
    const inputSchema = {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Channel to post to", enum: ["general", "random"] },
        text: { type: "string", description: "Message body" },
      },
      required: ["channel"],
    }
    const db = makeDb()
    const { mcaManager } = makeMcaManager([
      { name: "post-message", description: "Post a message", inputSchema },
    ])
    const handler = createGetMcaToolSchemasHandler(mcaManager, db)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "slack" })) as {
      tools: Array<{ tool: string; inputSchema: unknown; requiresInput: boolean }>
    }

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].tool).toBe("post-message")
    expect(result.tools[0].requiresInput).toBe(true)
    // Verbatim: required, descriptions, and enums preserved (D-02).
    expect(result.tools[0].inputSchema).toEqual(inputSchema)
  })

  it("(4) D-01: tool with empty properties → requiresInput false", async () => {
    const db = makeDb()
    const { mcaManager } = makeMcaManager([
      { name: "ping", description: "No inputs", inputSchema: { type: "object", properties: {} } },
    ])
    const handler = createGetMcaToolSchemasHandler(mcaManager, db)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "slack" })) as {
      tools: Array<{ requiresInput: boolean }>
    }

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].requiresInput).toBe(false)
  })

  it("(5) D-01: tool with an only-optional property (no required array) → requiresInput true", async () => {
    const db = makeDb()
    const { mcaManager } = makeMcaManager([
      {
        name: "search",
        description: "Optional query",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ])
    const handler = createGetMcaToolSchemasHandler(mcaManager, db)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "slack" })) as {
      tools: Array<{ requiresInput: boolean }>
    }

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].requiresInput).toBe(true)
  })

  it("(6) graceful empty: unknown/absent mcaId (source returns []) → { tools: [] }, no throw", async () => {
    const db = makeDb()
    const { mcaManager } = makeMcaManager([])
    const handler = createGetMcaToolSchemasHandler(mcaManager, db)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "does-not-exist" })) as {
      tools: unknown[]
    }

    expect(result).toEqual({ tools: [] })
  })

  it("(7) broken-skip: a tool missing inputSchema.properties is dropped, the rest returned", async () => {
    const db = makeDb()
    const { mcaManager } = makeMcaManager([
      {
        name: "good",
        description: "well-formed",
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
      },
      // Malformed: inputSchema present but properties undefined.
      { name: "broken", description: "malformed", inputSchema: { type: "object" } },
    ])
    const handler = createGetMcaToolSchemasHandler(mcaManager, db)

    const result = (await handler(ctx(USER_ADMIN), { mcaId: "slack" })) as {
      tools: Array<{ tool: string }>
    }

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].tool).toBe("good")
  })
})
