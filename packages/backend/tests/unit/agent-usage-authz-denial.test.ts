/**
 * Authz-denial tests for every admin-api.agent-usage-* handler (A7.4 / TER-673).
 *
 * The guards are discipline-only (a first `await requireSystemAdmin`). A refactor
 * that drops one passes typecheck + render tests but exposes cross-tenant
 * sessions/traces/costs. This asserts BEHAVIOURALLY that each handler rejects a
 * non-admin BEFORE touching any business collection — only `users` (the guard's
 * own read) may be reached.
 */

import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import {
  createAgentUsageHealthHandler,
  createAgentUsageInFlightHandler,
  createAgentUsageListAccessibleEntitiesHandler,
  createAgentUsageListSessionsHandler,
  createAgentUsageModelHealthHandler,
  createAgentUsageModelHealthTimeseriesHandler,
  createAgentUsageSessionDetailHandler,
  createAgentUsageTokensPerHourHandler,
  createAgentUsageToolExecutionsListHandler,
} from "../../src/handlers/domains/admin-api/agent-usage"

/** Fake Db that records which collections are accessed and denies admin. */
function makeDenyDb() {
  const accessed: string[] = []
  const chain: Record<string, unknown> = {}
  for (const m of ["find", "aggregate", "sort", "skip", "limit", "project", "maxTimeMS"]) {
    chain[m] = () => chain
  }
  chain.toArray = async () => []
  chain.findOne = async () => null
  const db = {
    collection(name: string) {
      accessed.push(name)
      if (name === "users") {
        // A non-admin user → requireSystemAdmin throws FORBIDDEN.
        return {
          async findOne() {
            return { userId: "u_1", role: "user" }
          },
        }
      }
      return chain
    },
  }
  return { db: db as unknown as Db, accessed }
}

const ctx = { userId: "u_1" } as WsHandlerContext
const rawData = {
  from: "2026-05-01T00:00:00Z",
  to: "2026-05-19T00:00:00Z",
  sessionUsageId: "usess_1",
}
const healthDeps = { buffer: {}, reconciler: {}, rollup: {} } as never

const HANDLERS: {
  name: string
  make: (db: Db) => (ctx: WsHandlerContext, raw: unknown) => Promise<unknown>
}[] = [
  { name: "tokens-per-hour", make: (db) => createAgentUsageTokensPerHourHandler(db) },
  { name: "list-sessions", make: (db) => createAgentUsageListSessionsHandler(db) },
  { name: "tool-executions-list", make: (db) => createAgentUsageToolExecutionsListHandler(db) },
  { name: "model-health", make: (db) => createAgentUsageModelHealthHandler(db) },
  {
    name: "model-health-timeseries",
    make: (db) => createAgentUsageModelHealthTimeseriesHandler(db),
  },
  { name: "in-flight", make: (db) => createAgentUsageInFlightHandler(db) },
  { name: "session-detail", make: (db) => createAgentUsageSessionDetailHandler(db) },
  {
    name: "list-accessible-entities",
    make: (db) => createAgentUsageListAccessibleEntitiesHandler(db),
  },
  { name: "health", make: (db) => createAgentUsageHealthHandler(db, healthDeps) },
]

describe("admin-api.agent-usage-* denies non-admins before any business read", () => {
  it("covers all nine actions", () => {
    expect(HANDLERS).toHaveLength(9)
  })

  for (const h of HANDLERS) {
    it(`${h.name} throws FORBIDDEN and touches only 'users'`, async () => {
      const { db, accessed } = makeDenyDb()
      const handler = h.make(db)
      await expect(handler(ctx, rawData)).rejects.toThrow(/admin/i)
      // The guard read `users`; NO business collection was touched (mutation:
      // dropping the guard lets the handler reach agent_usage_* → accessed grows).
      expect(accessed).toEqual(["users"])
    })
  }
})
