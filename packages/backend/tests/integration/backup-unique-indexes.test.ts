/**
 * Integration test: check-then-insert races are backed by unique indexes (MOD-5).
 *
 * - Migration 20261017_004: one private workspace per owner, one Teros
 *   provider and one default provider per user.
 * - WorkspaceService.createPrivateWorkspace: two concurrent calls return the
 *   same workspace, and the loser's volume is removed.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261017_004_backup_unique_indexes"
import { WorkspaceService } from "../../src/services/workspace-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_backupuniq_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[backup unique indexes test] Mongo unreachable — skipping")
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
  await migration.up(db)
})

describe("20261017_004_backup_unique_indexes", () => {
  it("allows one private workspace per owner, any number of shared ones", async () => {
    if (!available) return
    const ws = db.collection("workspaces")
    await ws.insertOne({ workspaceId: "w1", ownerId: "u1", type: "private" })
    await ws.insertOne({ workspaceId: "w2", ownerId: "u1", type: "shared" })
    await ws.insertOne({ workspaceId: "w3", ownerId: "u1", type: "shared" })

    await expect(
      ws.insertOne({ workspaceId: "w4", ownerId: "u1", type: "private" }),
    ).rejects.toThrow("E11000")
  })

  it("allows one Teros provider and one default provider per user", async () => {
    if (!available) return
    const p = db.collection("user_providers")
    await p.insertOne({ providerId: "p1", userId: "u1", providerType: "teros", isDefault: true })
    await p.insertOne({
      providerId: "p2",
      userId: "u1",
      providerType: "anthropic",
      isDefault: false,
    })

    await expect(
      p.insertOne({ providerId: "p3", userId: "u1", providerType: "teros" }),
    ).rejects.toThrow("E11000")
    await expect(
      p.insertOne({ providerId: "p4", userId: "u1", providerType: "openai", isDefault: true }),
    ).rejects.toThrow("E11000")
  })
})

describe("WorkspaceService.createPrivateWorkspace race", () => {
  it("two concurrent calls return the same workspace; the loser's volume is removed", async () => {
    if (!available) return
    let n = 0
    const volumeService = {
      createWorkspace: mock(async () => ({ volumeId: `vol_${++n}` })),
      deleteWorkspace: mock(async () => true),
    }
    const service = new WorkspaceService(db, volumeService as never)

    const [a, b] = await Promise.all([
      service.createPrivateWorkspace("u1"),
      service.createPrivateWorkspace("u1"),
    ])

    expect(a.workspaceId).toBe(b.workspaceId)
    expect(
      await db.collection("workspaces").countDocuments({ ownerId: "u1", type: "private" }),
    ).toBe(1)
    // Two volumes were created only if both passed the existence check; the
    // loser's must have been deleted
    expect(volumeService.deleteWorkspace.mock.calls.length).toBe(
      volumeService.createWorkspace.mock.calls.length - 1,
    )
  })
})
