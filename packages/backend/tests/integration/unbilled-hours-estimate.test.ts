/**
 * Integration test: estimateUnbilledHours (BIL-2 / BIL-3).
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { estimateUnbilledHours } from "../../src/services/unbilled-hours-estimate"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_unbilled_${Date.now()}`
const H = 3_600_000

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[unbilled hours test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

describe("estimateUnbilledHours", () => {
  it("reports time a billed hour is missing, and ignores hours not billed yet", async () => {
    if (!available) return
    const h10 = new Date("2026-10-16T10:00:00Z")
    const h11 = new Date(h10.getTime() + H)
    // A session 10:30-11:15 that closed after hour 10 had been rolled up
    await db.collection("agent_usage_sessions").insertOne({
      sessionUsageId: "s1",
      userId: "u1",
      agentId: "a1",
      workspaceId: "w1",
      provider: "p",
      status: "completed",
      totalTokens: 100,
      costUsd: 0,
      startedAt: new Date(h10.getTime() + 30 * 60_000),
      endedAt: new Date(h11.getTime() + 15 * 60_000),
    })
    // What was stored and billed for hour 10: nothing from s1
    await db.collection("agent_usage_rollups_user_hourly").insertOne({
      hourBucket: h10,
      groupKey: { userId: "u1", workspaceId: "w1" },
      userActiveMs: 0,
    })
    await db
      .collection("billing_subscriptions")
      .insertOne({ userId: "u1", status: "active", lastBilledHourBucket: h10 })

    const rows = await estimateUnbilledHours(db, h10, new Date(h11.getTime() + H))

    // 30 min of hour 10 were never billed; hour 11 is past the cursor (billed correctly later)
    expect(rows).toEqual([{ userId: "u1", unbilledHours: 0.5 }])
  })
})
