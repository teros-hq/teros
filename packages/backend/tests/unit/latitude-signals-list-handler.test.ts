/**
 * Unit tests for admin-api.latitude-signals-list (F4 · C2 handler).
 *
 * Mutation-verified. Covers:
 *   - boundary validation (`parseListSignalsParams`): clamp limit to [1,200],
 *     whitelist enums (unknown value dropped, never forwarded), trim + cap query;
 *   - the four `status` branches (unconfigured / unauthorized / unreachable / ok),
 *     none of which throw on a Latitude problem;
 *   - requireSystemAdmin is enforced (a non-admin caller is rejected).
 */

import { describe, expect, it } from "bun:test"
import {
  createLatitudeSignalsListHandler,
  parseListSignalsParams,
} from "../../src/handlers/domains/admin-api/latitude-signals"
import type {
  LatitudeReadClient,
  ListSignalsOutcome,
  ListSignalsParams,
} from "../../src/services/latitude-read-client"

const ctx = { userId: "admin_1" } as never

function fakeDb(role: string | null) {
  return {
    collection: (name: string) =>
      name === "users"
        ? { findOne: async () => (role ? { role } : null) }
        : { findOne: async () => null },
  } as never
}

function fakeClient(outcome: ListSignalsOutcome) {
  const calls: ListSignalsParams[] = []
  const client: LatitudeReadClient = {
    listSignals: async (params) => {
      calls.push(params)
      return outcome
    },
  }
  return { client, calls }
}

const OK: ListSignalsOutcome = {
  kind: "ok",
  signals: [{ id: "s1" } as never],
  nextCursor: "cur",
  hasMore: true,
}

describe("parseListSignalsParams (boundary validation)", () => {
  it("clamps limit into [1, 200] and floors fractions; defaults to 50", () => {
    expect(parseListSignalsParams({ limit: 1000 }).limit).toBe(200)
    expect(parseListSignalsParams({ limit: 0 }).limit).toBe(1)
    expect(parseListSignalsParams({ limit: -5 }).limit).toBe(1)
    expect(parseListSignalsParams({ limit: 3.7 }).limit).toBe(3)
    expect(parseListSignalsParams({}).limit).toBe(50)
    expect(parseListSignalsParams({ limit: "50" as never }).limit).toBe(50)
  })

  it("whitelists the enums — an unknown value is DROPPED, never forwarded", () => {
    expect(parseListSignalsParams({ lifecycleGroup: "active" }).lifecycleGroup).toBe("active")
    expect(parseListSignalsParams({ lifecycleGroup: "bogus" }).lifecycleGroup).toBeUndefined()
    expect(
      parseListSignalsParams({ lifecycleGroup: { $ne: null } as never }).lifecycleGroup,
    ).toBeUndefined()
    expect(parseListSignalsParams({ sortBy: "occurrences" }).sortBy).toBe("occurrences")
    expect(parseListSignalsParams({ sortBy: "evil" }).sortBy).toBeUndefined()
    expect(parseListSignalsParams({ sortDirection: "asc" }).sortDirection).toBe("asc")
    expect(parseListSignalsParams({ sortDirection: "sideways" }).sortDirection).toBeUndefined()
  })

  it("trims + caps the query and keeps an opaque cursor string only", () => {
    expect(parseListSignalsParams({ query: "  tool error  " }).query).toBe("tool error")
    expect(parseListSignalsParams({ query: "   " }).query).toBeUndefined()
    expect(parseListSignalsParams({ query: "x".repeat(600) }).query).toHaveLength(500)
    expect(parseListSignalsParams({ cursor: "abc" }).cursor).toBe("abc")
    expect(parseListSignalsParams({ cursor: 123 as never }).cursor).toBeUndefined()
  })
})

describe("createLatitudeSignalsListHandler (status branches)", () => {
  it("reports `unconfigured` and never calls a client when none is wired", async () => {
    const handler = createLatitudeSignalsListHandler(fakeDb("super"), null)
    const result = (await handler(ctx, {})) as { status: string; signals: unknown[] }
    expect(result.status).toBe("unconfigured")
    expect(result.signals).toEqual([])
  })

  it("passes validated params to the client and returns `ok` with the page", async () => {
    const { client, calls } = fakeClient(OK)
    const handler = createLatitudeSignalsListHandler(fakeDb("admin"), client)

    const result = (await handler(ctx, {
      limit: 999,
      sortBy: "occurrences",
      lifecycleGroup: "x",
    })) as {
      status: string
      signals: unknown[]
      nextCursor: string | null
      hasMore: boolean
    }

    expect(result.status).toBe("ok")
    expect(result.signals).toEqual(OK.kind === "ok" ? OK.signals : [])
    expect(result.nextCursor).toBe("cur")
    expect(result.hasMore).toBe(true)
    // The client saw the CLAMPED limit and the DROPPED bad enum — not the raw input.
    expect(calls[0]).toEqual({ limit: 200, sortBy: "occurrences" })
  })

  it("maps an unauthorized client outcome to `unauthorized`", async () => {
    const { client } = fakeClient({ kind: "unauthorized" })
    const handler = createLatitudeSignalsListHandler(fakeDb("super"), client)
    const result = (await handler(ctx, {})) as { status: string }
    expect(result.status).toBe("unauthorized")
  })

  it("maps a transport error to `unreachable` (does not throw)", async () => {
    const { client } = fakeClient({ kind: "error", status: 503 })
    const handler = createLatitudeSignalsListHandler(fakeDb("super"), client)
    const result = (await handler(ctx, {})) as { status: string }
    expect(result.status).toBe("unreachable")
  })
})

describe("createLatitudeSignalsListHandler (auth)", () => {
  it("rejects a non-admin caller before touching the client", async () => {
    const { client, calls } = fakeClient(OK)
    const handler = createLatitudeSignalsListHandler(fakeDb("user"), client)
    await expect(handler(ctx, {})).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
