/**
 * Integration test: withTransaction (INF-4).
 *
 * Against a replica set (CI's test compose, or MONGODB_URI pointing at one) a
 * failure inside `fn` rolls every write back. Against a standalone mongod
 * (production today) it degrades to running `fn` without a session.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { supportsTransactions, withTransaction } from "../../src/lib/mongo-transaction"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_tx_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let transactional = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
    transactional = await supportsTransactions(db)
    // Transactions can't create collections implicitly on older servers
    await db.createCollection("a")
    await db.createCollection("b")
  } catch {
    console.warn("[mongo transaction test] Mongo unreachable — skipping")
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
  await db.collection("a").deleteMany({})
  await db.collection("b").deleteMany({})
})

describe("withTransaction", () => {
  it("commits every write and returns fn's result", async () => {
    if (!available) return
    const result = await withTransaction(db, async (session) => {
      await db.collection("a").insertOne({ x: 1 }, { session })
      await db.collection("b").insertOne({ y: 1 }, { session })
      return "done"
    })

    expect(result).toBe("done")
    expect(await db.collection("a").countDocuments()).toBe(1)
    expect(await db.collection("b").countDocuments()).toBe(1)
  })

  it("on a replica set, a failure rolls back all writes; standalone keeps the old behaviour", async () => {
    if (!available) return
    await expect(
      withTransaction(db, async (session) => {
        await db.collection("a").insertOne({ x: 1 }, { session })
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    // Replica set: nothing persisted. Standalone: the first write stays (no tx).
    expect(await db.collection("a").countDocuments()).toBe(transactional ? 0 : 1)
  })

  it("passes a session only when transactions are supported", async () => {
    if (!available) return
    let seen: unknown = "unset"
    await withTransaction(db, async (session) => {
      seen = session
    })
    expect(seen === undefined).toBe(!transactional)
  })
})
