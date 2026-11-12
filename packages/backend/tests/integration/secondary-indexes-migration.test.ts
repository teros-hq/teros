/**
 * Integration test: 20260923_002_secondary_indexes (INF-1).
 *
 * The migration was never registered, so it never ran. Now that it does, it
 * must not abort boot on legacy data: duplicates under a unique index fall
 * back to a non-unique one, and an equivalent index created earlier under a
 * different name is kept.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20260923_002_secondary_indexes"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_secidx_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[secondary indexes migration test] Mongo unreachable — skipping")
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

describe("20260923_002_secondary_indexes", () => {
  it("creates the indexes and re-runs idempotently", async () => {
    if (!available) return
    await db.collection("billing_plans").insertOne({ _id: "plan_seed" as never })
    await migration.up(db)
    await migration.up(db)

    expect(await indexNames("user_providers")).toContain("providerId_unique")
    expect(await indexNames("agents")).toEqual(
      expect.arrayContaining(["ownerId_1", "workspaceId_1"]),
    )
    expect(await indexNames("usage_windows")).toContain("windowId_unique")
    // No index on the non-existent billing_plans.planId any more
    expect(await indexNames("billing_plans")).not.toContain("planId_unique")
  })

  it("falls back to a non-unique index when legacy data has duplicates", async () => {
    if (!available) return
    await db.collection("user_providers").insertMany([{ providerId: "p1" }, { providerId: "p1" }])

    await migration.up(db)

    const names = await indexNames("user_providers")
    expect(names).toContain("providerId_unique_nonunique")
    expect(names).not.toContain("providerId_unique")
  })

  it("keeps an equivalent index created earlier under another name", async () => {
    if (!available) return
    await db.collection("agent_cores").createIndex({ coreId: 1 }, { unique: true }) // default name coreId_1

    await migration.up(db)

    expect(await indexNames("agent_cores")).toContain("coreId_1")
  })

  it("down() removes them, fallbacks included", async () => {
    if (!available) return
    await db.collection("user_providers").insertMany([{ providerId: "p1" }, { providerId: "p1" }])
    await migration.up(db)

    await migration.down?.(db)

    expect(await indexNames("user_providers")).toEqual(["_id_"])
    expect(await indexNames("agents")).toEqual(["_id_"])
  })
})
