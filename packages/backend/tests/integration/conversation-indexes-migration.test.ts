/**
 * Integration test: 20261017_002_conversation_indexes (INF-2).
 *
 * The channel message index pointed at `createdAt`, a field messages don't
 * have: reading a channel's messages scanned and sorted it in memory. Checks
 * the plan the real query gets now, plus the duplicate-safe unique index.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261017_002_conversation_indexes"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_convidx_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[conversation indexes test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

beforeEach(async () => {
  if (available) await db.dropDatabase()
})

const indexNames = async (col: string) => (await db.collection(col).indexes()).map((i) => i.name)

/** All stage names in an explain winningPlan tree (recursive). */
function planStages(plan: any): string[] {
  if (!plan) return []
  const out: string[] = []
  if (plan.stage) out.push(plan.stage)
  if (plan.inputStage) out.push(...planStages(plan.inputStage))
  for (const s of plan.inputStages ?? []) out.push(...planStages(s))
  return out
}

async function seedMessages() {
  const docs = Array.from({ length: 50 }, (_, i) => ({
    messageId: `msg_${i}`,
    channelId: i % 2 ? "ch_a" : "ch_b",
    timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }))
  await db.collection("channel_messages").insertMany(docs)
  // The legacy index the migration replaces
  await db
    .collection("channel_messages")
    .createIndex({ channelId: 1, createdAt: -1 }, { name: "channelId_1_createdAt_-1" })
}

describe("20261017_002_conversation_indexes", () => {
  it("serves the channel message read from the index, without an in-memory sort", async () => {
    if (!available) return
    await seedMessages()
    await migration.up(db)

    const explain = await db
      .collection("channel_messages")
      .find({ channelId: "ch_a" })
      .sort({ timestamp: -1 })
      .limit(20)
      .explain("queryPlanner")
    const stages = planStages((explain as any).queryPlanner.winningPlan)

    expect(stages).toContain("IXSCAN")
    expect(stages).not.toContain("SORT")
    expect(await indexNames("channel_messages")).not.toContain("channelId_1_createdAt_-1")
  })

  it("creates the other indexes and re-runs idempotently", async () => {
    if (!available) return
    await seedMessages()
    await migration.up(db)
    await migration.up(db)

    expect(await indexNames("channel_messages")).toContain("messageId_unique")
    expect(await indexNames("sessions")).toContain("id_unique")
    expect(await indexNames("llm_usage")).toContain("userId_timestamp")
    expect(await indexNames("projects")).toContain("projectId_1")
    expect(await indexNames("skills")).toEqual(
      expect.arrayContaining(["skillId_unique", "workspaceId_name"]),
    )
    expect(await indexNames("agent_skill_access")).toEqual(
      expect.arrayContaining(["agentId_skillId_unique", "agentId_order"]),
    )
  })

  it("falls back to non-unique when legacy messages share a messageId", async () => {
    if (!available) return
    await db.collection("channel_messages").insertMany([
      { messageId: "dup", channelId: "ch_a", timestamp: "2026-10-01T00:00:00Z" },
      { messageId: "dup", channelId: "ch_a", timestamp: "2026-10-01T00:00:01Z" },
    ])

    await migration.up(db)

    expect(await indexNames("channel_messages")).toContain("messageId_unique_nonunique")
  })

  it("down() restores the previous state", async () => {
    if (!available) return
    await seedMessages()
    await migration.up(db)
    await migration.down?.(db)

    expect(await indexNames("channel_messages")).toEqual(["_id_", "channelId_1_createdAt_-1"])
  })
})
