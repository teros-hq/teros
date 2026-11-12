/**
 * Integration test: task arrays stay bounded (MOD-3).
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { cappedPush } from "../../src/lib/task-arrays"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_taskcaps_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[task array caps test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

describe("cappedPush", () => {
  it("keeps only the newest entries, for single and batched pushes", async () => {
    if (!available) return
    const tasks = db.collection("tasks")
    await tasks.insertOne({ taskId: "t1", activity: [] })

    for (let i = 0; i < 7; i++) {
      await tasks.updateOne(
        { taskId: "t1" },
        { $push: { activity: cappedPush({ n: i }, 5) } as never },
      )
    }
    await tasks.updateOne(
      { taskId: "t1" },
      { $push: { activity: cappedPush([{ n: 7 }, { n: 8 }], 5) } as never },
    )

    const task = await tasks.findOne({ taskId: "t1" })
    expect(task?.activity.map((a: { n: number }) => a.n)).toEqual([4, 5, 6, 7, 8])
  })
})
