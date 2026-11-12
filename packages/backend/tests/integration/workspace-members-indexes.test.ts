/**
 * Integration test: 20261017_003_workspace_members_indexes (INF-6, MOD-5).
 *
 * The sparse compound unique index indexed pending invitations (no userId) as
 * (workspaceId, null), so a second pending invitation to the same workspace
 * failed with E11000. Reproduced on the old index, then fixed by the migration.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261017_003_workspace_members_indexes"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_wsmembers_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[workspace members indexes test] Mongo unreachable — skipping")
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
  await db.dropDatabase()
  // The index as WorkspaceService.ensureIndexes used to create it
  await db
    .collection("workspace_members")
    .createIndex({ workspaceId: 1, userId: 1 }, { unique: true, sparse: true })
})

const pending = (email: string) => ({
  workspaceId: "work_1",
  email,
  status: "pending",
  role: "write",
})

describe("workspace_members indexes", () => {
  it("reproduces the bug on the old sparse index: a second pending invitation fails", async () => {
    if (!available) return
    await db.collection("workspace_members").insertOne(pending("a@example.com"))

    await expect(
      db.collection("workspace_members").insertOne(pending("b@example.com")),
    ).rejects.toThrow("E11000")
  })

  it("after the migration, several pending invitations coexist", async () => {
    if (!available) return
    await migration.up(db)

    await db.collection("workspace_members").insertOne(pending("a@example.com"))
    await db.collection("workspace_members").insertOne(pending("b@example.com"))
    expect(await db.collection("workspace_members").countDocuments({ status: "pending" })).toBe(2)
  })

  it("still forbids a duplicate active membership", async () => {
    if (!available) return
    await migration.up(db)
    const member = { workspaceId: "work_1", userId: "user_1", status: "active", role: "write" }

    await db.collection("workspace_members").insertOne({ ...member })
    await expect(db.collection("workspace_members").insertOne({ ...member })).rejects.toThrow(
      "E11000",
    )
  })

  it("forbids inviting the same email twice while pending (MOD-5)", async () => {
    if (!available) return
    await migration.up(db)

    await db.collection("workspace_members").insertOne(pending("a@example.com"))
    await expect(
      db.collection("workspace_members").insertOne(pending("a@example.com")),
    ).rejects.toThrow("E11000")
  })

  it("down() restores the sparse index", async () => {
    if (!available) return
    await migration.up(db)
    await migration.down?.(db)

    const names = (await db.collection("workspace_members").indexes()).map((i) => i.name)
    expect(names).toEqual(["_id_", "workspaceId_1_userId_1"])
  })
})
