/**
 * Unit tests — app.get-mca-health / app.record-mca-health (Phase 5, TEST-06).
 *
 * Proves the Phase 5 backend contract (ROADMAP SC2 + SC3):
 *   - Admin gate: a non-admin caller is rejected FORBIDDEN BEFORE any DB access
 *     (find / bulkWrite must never run) — T-05-04.
 *   - get-mca-health: admin read returns a flat { mcaId, tool, status, testedAt,
 *     error? } array; Date testedAt → ISO string; absent error key omitted (D-02/D-05).
 *   - record-mca-health: empty/missing results → INVALID_REQUEST; a valid batch
 *     upserts once per result with filter { mcaId, tool }, $setOnInsert.createdAt,
 *     { upsert: true }, and mcaId/tool NEVER in $set (D-03 overwrite-not-append).
 *   - record-mca-health: over-length error truncated to exactly 500 chars (D-06/SC3);
 *     $set carries no appId/inputs/outputs (D-07/SC3).
 *
 * No real MongoDB — Db is mocked like agent-app-admin-authz.test.ts. The denied
 * cases assert the protected op was never invoked.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createGetMcaHealthHandler } from "../../src/handlers/domains/app/get-mca-health"
import { createRecordMcaHealthHandler } from "../../src/handlers/domains/app/record-mca-health"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ADMIN = "user_admin"
const USER_PLAIN = "user_plain"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

// ---------------------------------------------------------------------------
// Mock Db
//
//   users:
//     USER_ADMIN → { role: 'admin' }  (passes requireSystemAdmin)
//     USER_PLAIN → { role: 'user' }   (rejected FORBIDDEN)
//   mca_tool_health:
//     find().toArray() → canned rows (settable per test)
//     bulkWrite        → records the ops array (one updateOne op per result)
// ---------------------------------------------------------------------------

function makeDb(healthRows: unknown[] = []) {
  const toArray = mock(async () => healthRows)
  const find = mock(() => ({ toArray }))
  const bulkWrite = mock(async (_ops: unknown[]) => ({ ok: 1 }))

  const collections: Record<string, any> = {
    users: {
      findOne: mock(async (filter: any) => {
        if (filter.userId === USER_ADMIN) return { userId: USER_ADMIN, role: "admin" }
        if (filter.userId === USER_PLAIN) return { userId: USER_PLAIN, role: "user" }
        return null
      }),
    },
    mca_tool_health: { find, bulkWrite },
  }

  const db = {
    collection: mock((name: string) => collections[name] ?? { findOne: mock(async () => null) }),
  } as any

  return { db, find, toArray, bulkWrite }
}

// ===========================================================================
// get-mca-health
// ===========================================================================

describe("app.get-mca-health handler", () => {
  it("(1) rejects a non-admin caller FORBIDDEN and never reads the collection", async () => {
    const { db, find } = makeDb()
    const handler = createGetMcaHealthHandler(db)

    await expect(handler(ctx(USER_PLAIN), {})).rejects.toMatchObject({ code: "FORBIDDEN" })

    expect(find).not.toHaveBeenCalled()
  })

  it("(2) admin read returns a flat array: Date testedAt → ISO string, error omitted when absent", async () => {
    const testedAt = new Date("2026-06-30T00:00:00.000Z")
    const { db } = makeDb([
      { mcaId: "slack", tool: "list-channels", status: "ok", testedAt },
      {
        mcaId: "google-drive",
        tool: "upload-file",
        status: "fail",
        testedAt,
        error: "403 on shared drive",
      },
    ])
    const handler = createGetMcaHealthHandler(db)

    const result = (await handler(ctx(USER_ADMIN), {})) as {
      health: Array<{
        mcaId: string
        tool: string
        status: string
        testedAt: string
        error?: string
      }>
    }

    expect(result.health).toHaveLength(2)
    // Row without error: error key omitted, testedAt is the ISO string.
    expect(result.health[0]).toEqual({
      mcaId: "slack",
      tool: "list-channels",
      status: "ok",
      testedAt: "2026-06-30T00:00:00.000Z",
    })
    expect("error" in result.health[0]).toBe(false)
    // Row with error: error preserved.
    expect(result.health[1]).toEqual({
      mcaId: "google-drive",
      tool: "upload-file",
      status: "fail",
      testedAt: "2026-06-30T00:00:00.000Z",
      error: "403 on shared drive",
    })
  })

  it("(2b) a row missing testedAt degrades to an omitted key — the fleet read must not throw", async () => {
    const testedAt = new Date("2026-06-30T00:00:00.000Z")
    const { db } = makeDb([
      // Malformed row (manual edit / partial writer): no testedAt Date.
      { mcaId: "slack", tool: "list-channels", status: "ok" },
      { mcaId: "gmail", tool: "send-email", status: "ok", testedAt },
    ])
    const handler = createGetMcaHealthHandler(db)

    const result = (await handler(ctx(USER_ADMIN), {})) as {
      health: Array<{ testedAt?: string }>
    }

    expect(result.health).toHaveLength(2)
    expect("testedAt" in result.health[0]).toBe(false)
    expect(result.health[1].testedAt).toBe("2026-06-30T00:00:00.000Z")
  })
})

// ===========================================================================
// record-mca-health
// ===========================================================================

describe("app.record-mca-health handler", () => {
  it("(3) rejects a non-admin caller FORBIDDEN and never writes", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    await expect(
      handler(ctx(USER_PLAIN), {
        results: [{ mcaId: "slack", tool: "list-channels", status: "ok" }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    expect(bulkWrite).not.toHaveBeenCalled()
  })

  it("(4) admin caller with empty/missing results → INVALID_REQUEST", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    await expect(handler(ctx(USER_ADMIN), { results: [] })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    await expect(handler(ctx(USER_ADMIN), {})).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    expect(bulkWrite).not.toHaveBeenCalled()
  })

  it("(4b) a result missing mcaId/tool/status → INVALID_REQUEST", async () => {
    const { db } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    await expect(
      handler(ctx(USER_ADMIN), { results: [{ mcaId: "slack", tool: "", status: "ok" }] }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })

  it("(4c) a result whose status is outside the enum → INVALID_REQUEST, never written", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    // Truthy but not a ToolTestStatus member — the dashboard's `overall`
    // derivation can't render it, so it must be rejected at the boundary.
    await expect(
      handler(ctx(USER_ADMIN), {
        results: [{ mcaId: "slack", tool: "list-channels", status: "garbage" as never }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })

    // A batch with one bad element must not partially persist the good ones.
    await expect(
      handler(ctx(USER_ADMIN), {
        results: [
          { mcaId: "slack", tool: "list-channels", status: "ok" },
          { mcaId: "gmail", tool: "get-message", status: "nope" as never },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })

    expect(bulkWrite).not.toHaveBeenCalled()
  })

  it("(5) admin valid batch: ONE bulkWrite with one upsert op per result — filter {mcaId,tool}, $setOnInsert.createdAt, upsert:true, mcaId/tool NOT in $set; returns { recorded }", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    const result = (await handler(ctx(USER_ADMIN), {
      results: [
        { mcaId: "slack", tool: "list-channels", status: "ok" },
        { mcaId: "notion", tool: "list-pages", status: "fail", error: "401 unauthorized" },
      ],
    })) as { recorded: number }

    expect(result).toEqual({ recorded: 2 })
    // Whole batch in a single round-trip: ONE bulkWrite carrying 2 updateOne ops.
    expect(bulkWrite).toHaveBeenCalledTimes(1)
    const ops = bulkWrite.mock.calls[0][0] as any[]
    expect(ops).toHaveLength(2)

    // First op — proves overwrite-not-append semantics (D-03).
    const { filter, update, upsert } = ops[0].updateOne
    expect(filter).toEqual({ mcaId: "slack", tool: "list-channels" })
    expect(upsert).toBe(true)
    const set = (update as any).$set
    expect(set.status).toBe("ok")
    expect(set.testedAt).toBeInstanceOf(Date)
    // Filter keys must NEVER appear in $set (analog invariant).
    expect("mcaId" in set).toBe(false)
    expect("tool" in set).toBe(false)
    // createdAt only on insert.
    expect((update as any).$setOnInsert).toHaveProperty("createdAt")
    expect((update as any).$setOnInsert.createdAt).toBeInstanceOf(Date)

    // The whole batch shares ONE server-generated timestamp (D-05).
    const set2 = (ops[1].updateOne.update as any).$set
    expect(set2.testedAt).toBe(set.testedAt)
  })

  it("(6) over-length error truncated to exactly 500 chars (D-06 / SC3)", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    const longError = "x".repeat(1000)
    await handler(ctx(USER_ADMIN), {
      results: [{ mcaId: "gmail", tool: "delete-email", status: "confirm", error: longError }],
    })

    const set = ((bulkWrite.mock.calls[0][0] as any[])[0].updateOne.update as any).$set
    expect(set.error).toHaveLength(500)
  })

  it("(7) $set carries no appId/inputs/outputs (D-07 / SC3 minimal-field guarantee)", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    await handler(ctx(USER_ADMIN), {
      // Even if a caller smuggles extra fields, only the minimal shape is persisted.
      results: [
        {
          mcaId: "slack",
          tool: "post-message",
          status: "ok",
          appId: "app_secret",
          inputs: { token: "sk-leak" },
          outputs: { body: "pii" },
        } as any,
      ],
    })

    const set = ((bulkWrite.mock.calls[0][0] as any[])[0].updateOne.update as any).$set
    expect("appId" in set).toBe(false)
    expect("inputs" in set).toBe(false)
    expect("outputs" in set).toBe(false)
  })

  it("(8) a result with no error $unsets any previously-stored error (stale-note clear)", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    // A tool that recovered to ok carries no error. The upsert-overwrite must actively clear a
    // stale error left on the record from a prior failed run — otherwise a later read renders it.
    await handler(ctx(USER_ADMIN), {
      results: [{ mcaId: "slack", tool: "post-message", status: "ok" }],
    })

    const update = (bulkWrite.mock.calls[0][0] as any[])[0].updateOne.update as any
    expect("error" in update.$set).toBe(false)
    expect(update.$unset).toEqual({ error: "" })
  })

  it("(9) a result WITH an error sets it and issues no $unset", async () => {
    const { db, bulkWrite } = makeDb()
    const handler = createRecordMcaHealthHandler(db)

    await handler(ctx(USER_ADMIN), {
      results: [{ mcaId: "slack", tool: "post-message", status: "fail", error: "boom" }],
    })

    const update = (bulkWrite.mock.calls[0][0] as any[])[0].updateOne.update as any
    expect(update.$set.error).toBe("boom")
    expect("$unset" in update).toBe(false)
  })
})
