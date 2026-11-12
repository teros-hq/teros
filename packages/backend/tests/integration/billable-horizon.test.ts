/**
 * Integration test: billable horizon (BIL-2 / BIL-3).
 *
 * The tracker bills rollups with hourBucket > cursor and moves the cursor to
 * the newest billed hour. Before the horizon, a failed or still-open hour H
 * followed by a good H+1 let the cursor jump over H, so H's hours were never
 * billed once it was finally rolled up. Runs the real tracker against Mongo.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { AgentHoursTracker } from "../../src/services/agent-hours-tracker"
import {
  computeBillableHorizon,
  rollupCutoff,
  truncateToHourUTC,
} from "../../src/services/agent-usage-rollup-job"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_horizon_${Date.now()}`
const H = 3_600_000

let client: MongoClient
let db: Db
let available = false

const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLog
  },
} as never

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[billable horizon test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

beforeEach(async () => {
  if (!available) return
  for (const name of [
    "agent_usage_rollup_runs",
    "agent_usage_rollups_user_hourly",
    "billing_subscriptions",
    "billing_hour_ledger",
  ]) {
    await db.collection(name).deleteMany({})
  }
})

const opts = { offsetMin: 5, catchUpHours: 6 }
const mark = (hourBucket: Date) =>
  db.collection("agent_usage_rollup_runs").insertOne({ hourBucket, completedAt: new Date() })
const rollup = (hourBucket: Date, ms: number) =>
  db.collection("agent_usage_rollups_user_hourly").insertOne({
    hourBucket,
    groupKey: { userId: "user_1", workspaceId: "work_1" },
    userActiveMs: ms,
  })

describe("rollupCutoff", () => {
  it("waits offsetMin after the hour ends", () => {
    expect(rollupCutoff(new Date("2026-10-17T11:02:00Z"), 5)).toEqual(
      new Date("2026-10-17T10:00:00Z"),
    )
    expect(rollupCutoff(new Date("2026-10-17T11:06:00Z"), 5)).toEqual(
      new Date("2026-10-17T11:00:00Z"),
    )
  })
})

describe("computeBillableHorizon", () => {
  it("stops at the first unmarked hour of the window", async () => {
    if (!available) return
    const now = new Date("2026-10-17T12:10:00Z")
    const start = new Date(truncateToHourUTC(now).getTime() - 6 * H) // 06:00
    for (let i = 0; i < 6; i++) if (i !== 3) await mark(new Date(start.getTime() + i * H))

    expect(await computeBillableHorizon(db, now, opts)).toEqual(new Date(start.getTime() + 3 * H))
  })

  it("is the rollup cutoff when every hour is marked", async () => {
    if (!available) return
    const now = new Date("2026-10-17T12:10:00Z")
    const start = new Date(truncateToHourUTC(now).getTime() - 6 * H)
    for (let i = 0; i < 6; i++) await mark(new Date(start.getTime() + i * H))

    expect(await computeBillableHorizon(db, now, opts)).toEqual(new Date("2026-10-17T12:00:00Z"))
  })
})

describe("tracker + horizon (BIL-3)", () => {
  it("does not bill past an unfinished hour, then bills both once it is final", async () => {
    if (!available) return
    const now = new Date()
    const current = truncateToHourUTC(now)
    const hFail = new Date(current.getTime() - 3 * H) // rolled up later
    const hGood = new Date(current.getTime() - 2 * H)
    const before = new Date(current.getTime() - 4 * H)

    await db.collection("billing_subscriptions").insertOne({
      _id: "sub_1" as never,
      userId: "user_1",
      planId: "plan_x",
      status: "active",
      agentHoursUsed: 0,
      lastBilledHourBucket: before,
      currentPeriodEnd: new Date(now.getTime() + 10 * 24 * H),
    })
    // Every hour of the window is final except hFail
    for (let t = current.getTime() - 72 * H; t < current.getTime(); t += H) {
      if (t !== hFail.getTime()) await mark(new Date(t))
    }
    await rollup(hFail, 0.5 * H) // partial: will grow when finalised
    await rollup(hGood, 1 * H)

    const tracker = new AgentHoursTracker(db, silentLog, null)
    await tracker.runOnce()

    let sub = await db.collection("billing_subscriptions").findOne({ _id: "sub_1" as never })
    expect(sub?.agentHoursUsed).toBe(0) // nothing billed past the unfinished hour
    expect(sub?.lastBilledHourBucket).toEqual(before)

    // The hour is finalised with its full time, then marked
    await db
      .collection("agent_usage_rollups_user_hourly")
      .updateOne({ hourBucket: hFail }, { $set: { userActiveMs: 0.75 * H } })
    await mark(hFail)
    await tracker.runOnce()

    sub = await db.collection("billing_subscriptions").findOne({ _id: "sub_1" as never })
    expect(sub?.agentHoursUsed).toBeCloseTo(1.75, 6) // both hours, full value
  })
})
