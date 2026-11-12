/**
 * Integration test: the migration runner applies migrations from one instance
 * at a time (INF-5).
 *
 * Two instances booting together (staging runs 2) both used to run up(): the
 * second then hit E11000 on `_migrations` and aborted boot, after a
 * non-idempotent up() had already run twice.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { type MigrationEntry, runMigrations } from "../../src/migrations/runner"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_migrunner_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[migration runner lock test] Mongo unreachable — skipping")
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

/** Slow, non-idempotent migrations that count how often up() ran. */
function countingMigrations(calls: Record<string, number>): MigrationEntry[] {
  return ["20990101_001_first", "20990101_002_second"].map((name) => ({
    name,
    migration: {
      description: name,
      async up() {
        calls[name] = (calls[name] ?? 0) + 1
        await new Promise((r) => setTimeout(r, 150))
      },
    },
  }))
}

describe("runMigrations lock", () => {
  it("two concurrent boots apply each migration exactly once and both succeed", async () => {
    if (!available) return
    const calls: Record<string, number> = {}
    const migrations = countingMigrations(calls)

    await Promise.all([
      runMigrations(db, { ownerId: "instance-a", migrations, lockPollMs: 20 }),
      runMigrations(db, { ownerId: "instance-b", migrations, lockPollMs: 20 }),
    ])

    expect(calls).toEqual({ "20990101_001_first": 1, "20990101_002_second": 1 })
    expect(await db.collection("_migrations").countDocuments({})).toBe(2)
    // The lock is released when done
    expect(await db.collection("leader_locks").countDocuments({ name: "migrations" })).toBe(0)
  })

  it("fails startup if another instance holds the lock for too long", async () => {
    if (!available) return
    await db.collection("leader_locks").insertOne({
      name: "migrations",
      ownerId: "someone-else",
      expiresAt: new Date(Date.now() + 60_000),
    })
    const calls: Record<string, number> = {}

    await expect(
      runMigrations(db, {
        ownerId: "instance-a",
        migrations: countingMigrations(calls),
        lockWaitMs: 100,
        lockPollMs: 20,
      }),
    ).rejects.toThrow("held the migrations lock too long")
    expect(calls).toEqual({})
  })
})
