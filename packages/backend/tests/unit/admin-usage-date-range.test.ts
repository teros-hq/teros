/**
 * admin-api.usage — date-range filtering tests.
 *
 * Verifies that all usage handlers correctly apply startDate/endDate to the
 * MongoDB aggregation $match stage, with proper fallback to period and default.
 *
 * Run: bun test packages/backend/tests/unit/admin-usage-date-range.test.ts
 */

import { describe, expect, it, mock } from "bun:test"
import type { Db } from "mongodb"
import {
  createUsageByAgentHandler,
  createUsageByModelHandler,
  createUsageByUserHandler,
  createUsageByWorkspaceHandler,
  createUsageExpensiveConversationsHandler,
  createUsageSummaryHandler,
} from "../../src/handlers/domains/admin-api/usage"

// ---------------------------------------------------------------------------
// Fake Db that captures the aggregation pipeline
// ---------------------------------------------------------------------------

interface CapturedPipeline {
  collection: string
  pipeline: Record<string, unknown>[]
}

function createFakeDb(captured: CapturedPipeline[]): Db {
  return {
    collection: (name: string) => ({
      findOne: mock(async () => ({ userId: "admin-user", role: "admin" })),
      aggregate: (pipeline: Record<string, unknown>[]) => {
        captured.push({ collection: name, pipeline })
        return { toArray: mock(async () => []) }
      },
    }),
  } as unknown as Db
}

const ctx = { userId: "admin-user" } as any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMatchStage(captured: CapturedPipeline[]): Record<string, unknown> {
  expect(captured.length).toBeGreaterThan(0)
  const pipeline = captured[0].pipeline
  const matchStage = pipeline[0] as { $match: Record<string, unknown> }
  expect(matchStage).toHaveProperty("$match")
  return matchStage.$match
}

function getTimestampFilter(captured: CapturedPipeline[]): { $gte?: Date; $lte?: Date } {
  const match = getMatchStage(captured)
  return match.timestamp as { $gte?: Date; $lte?: Date }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usage-by-user date range", () => {
  it("applies startDate and endDate to the $match stage", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByUserHandler(db)

    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    const ts = getTimestampFilter(captured)
    expect(ts.$gte).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(ts.$lte).toEqual(new Date("2026-09-30T23:59:59.999Z"))
  })

  it("applies only startDate when endDate is omitted", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByUserHandler(db)

    await handler(ctx, { startDate: "2026-09-01T00:00:00.000Z" })

    const ts = getTimestampFilter(captured)
    expect(ts.$gte).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(ts.$lte).toBeUndefined()
  })

  it("falls back to period when no startDate/endDate given", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByUserHandler(db)

    const before = new Date()
    await handler(ctx, { period: "week" })
    const after = new Date()

    const ts = getTimestampFilter(captured)
    const weekAgo = new Date(before.getTime() - 7 * 24 * 60 * 60 * 1000)
    // Allow 1s tolerance for test execution time.
    expect(ts.$gte!.getTime()).toBeGreaterThanOrEqual(weekAgo.getTime() - 1000)
    expect(ts.$gte!.getTime()).toBeLessThanOrEqual(after.getTime() - 7 * 24 * 60 * 60 * 1000 + 1000)
    expect(ts.$lte).toBeUndefined()
  })

  it("defaults to last 24h when no params given", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByUserHandler(db)

    const before = new Date()
    await handler(ctx, {})
    const after = new Date()

    const ts = getTimestampFilter(captured)
    const dayAgo = new Date(before.getTime() - 24 * 60 * 60 * 1000)
    expect(ts.$gte!.getTime()).toBeGreaterThanOrEqual(dayAgo.getTime() - 1000)
    expect(ts.$gte!.getTime()).toBeLessThanOrEqual(after.getTime() - 24 * 60 * 60 * 1000 + 1000)
  })

  it("returns startDate/endDate in the response envelope", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByUserHandler(db)

    const result = await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    expect(result.period).toBe("custom")
    expect(result.startDate).toBe("2026-09-01T00:00:00.000Z")
    expect(result.endDate).toBe("2026-09-30T23:59:59.999Z")
  })

  it("September-only range excludes October activity (regression: Evidence query C)", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByUserHandler(db)

    // September-only query: must NOT include any data from October.
    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    const ts = getTimestampFilter(captured)
    // The $lte bound must be before October 1st.
    expect(ts.$lte!.getTime()).toBeLessThan(new Date("2026-10-01T00:00:00.000Z").getTime())
  })
})

describe("usage-by-workspace date range", () => {
  it("applies startDate/endDate to the $match stage", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByWorkspaceHandler(db)

    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    const ts = getTimestampFilter(captured)
    expect(ts.$gte).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(ts.$lte).toEqual(new Date("2026-09-30T23:59:59.999Z"))
  })
})

describe("usage-by-agent date range", () => {
  it("applies startDate/endDate to the $match stage", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByAgentHandler(db)

    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    const ts = getTimestampFilter(captured)
    expect(ts.$gte).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(ts.$lte).toEqual(new Date("2026-09-30T23:59:59.999Z"))
  })
})

describe("usage-by-model date range", () => {
  it("applies startDate/endDate to the $match stage", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByModelHandler(db)

    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    const ts = getTimestampFilter(captured)
    expect(ts.$gte).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(ts.$lte).toEqual(new Date("2026-09-30T23:59:59.999Z"))
  })
})

describe("usage-expensive-conversations date range", () => {
  it("applies startDate/endDate to the $match stage", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageExpensiveConversationsHandler(db)

    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    const ts = getTimestampFilter(captured)
    expect(ts.$gte).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(ts.$lte).toEqual(new Date("2026-09-30T23:59:59.999Z"))
  })

  it("defaults to week when no date range given", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageExpensiveConversationsHandler(db)

    const before = new Date()
    await handler(ctx, {})
    const after = new Date()

    const ts = getTimestampFilter(captured)
    const weekAgo = new Date(before.getTime() - 7 * 24 * 60 * 60 * 1000)
    expect(ts.$gte!.getTime()).toBeGreaterThanOrEqual(weekAgo.getTime() - 1000)
    expect(ts.$gte!.getTime()).toBeLessThanOrEqual(after.getTime() - 7 * 24 * 60 * 60 * 1000 + 1000)
  })
})

describe("usage-summary date range", () => {
  it("applies startDate/endDate to the $match stage", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageSummaryHandler(db)

    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })

    const ts = getTimestampFilter(captured)
    expect(ts.$gte).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(ts.$lte).toEqual(new Date("2026-09-30T23:59:59.999Z"))
  })
})

describe("month-long superset invariant", () => {
  it("month range $gte <= day range $gte for any day within that month", async () => {
    const captured: CapturedPipeline[] = []
    const db = createFakeDb(captured)
    const handler = createUsageByUserHandler(db)

    // Month-long query
    await handler(ctx, {
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-30T23:59:59.999Z",
    })
    const monthTs = getTimestampFilter(captured)

    captured.length = 0

    // Single-day query within that month
    await handler(ctx, {
      startDate: "2026-09-15T00:00:00.000Z",
      endDate: "2026-09-15T23:59:59.999Z",
    })
    const dayTs = getTimestampFilter(captured)

    // Month start must be <= day start (superset guarantee).
    expect(monthTs.$gte!.getTime()).toBeLessThanOrEqual(dayTs.$gte!.getTime())
    // Month end must be >= day end.
    expect(monthTs.$lte!.getTime()).toBeGreaterThanOrEqual(dayTs.$lte!.getTime())
  })
})
