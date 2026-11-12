/**
 * Integration test: the central index registry against a real MongoDB (GOV-4).
 *
 *   - ensureAllIndexes on a fresh DB creates every declared index, and a
 *     second run changes nothing (idempotent, no conflict warnings).
 *   - Boot order: running every migration and then ensureAllIndexes on a fresh
 *     DB does not throw (catches 85/86 conflicts between the two); the reverse
 *     order doesn't either.
 *   - `heal` entries replace a same-name index whose spec changed; a unique
 *     index that already fell back to `<name>_nonunique` is not retried.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { ensureAllIndexes, INDEXES, type IndexDef } from "../../src/db/indexes"
import { MIGRATIONS } from "../../src/migrations/runner"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_db_indexes_${Date.now()}`
/** Building ~270 indexes (and running every migration) takes a few seconds. */
const SLOW = 120_000

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    await db.command({ ping: 1 })
    available = true
  } catch {
    console.warn("[db indexes test] Mongo unreachable — skipping")
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

/** collection.name → the index document, for every non-_id index in the DB. */
async function snapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const { name: collection } of await db.listCollections().toArray()) {
    for (const ix of await db.collection(collection).listIndexes().toArray()) {
      if (ix.name !== "_id_") out.set(`${collection}.${ix.name}`, JSON.stringify(ix))
    }
  }
  return out
}

/** Runs fn with console.log/warn silenced; returns the warnings. */
async function quietly(fn: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = []
  const log = spyOn(console, "log").mockImplementation(() => {})
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.join(" "))
  })
  try {
    await fn()
  } finally {
    log.mockRestore()
    warn.mockRestore()
  }
  return warnings
}

async function runAllMigrations(): Promise<void> {
  for (const { migration } of MIGRATIONS) await migration.up(db)
}

describe("ensureAllIndexes", () => {
  it("creates every declared index on a fresh DB, and a second run is a no-op", async () => {
    if (!available) return
    const firstWarnings = await quietly(() => ensureAllIndexes(db))
    expect(firstWarnings).toEqual([])

    const created = await snapshot()
    const missing: string[] = []
    for (const [collection, defs] of Object.entries(INDEXES) as Array<[string, readonly IndexDef[]]>) {
      for (const def of defs) {
        const ix = created.get(`${collection}.${def.name}`)
        if (!ix) {
          missing.push(`${collection}.${def.name}`)
          continue
        }
        const parsed = JSON.parse(ix)
        expect(parsed.key).toEqual(def.key)
        expect(Boolean(parsed.unique)).toBe(Boolean(def.unique))
        expect(parsed.partialFilterExpression).toEqual(def.partialFilterExpression)
        expect(parsed.expireAfterSeconds).toEqual(def.expireAfterSeconds)
      }
    }
    expect(missing).toEqual([])

    const secondWarnings = await quietly(() => ensureAllIndexes(db))
    expect(secondWarnings).toEqual([])
    expect(await snapshot()).toEqual(created)
  }, SLOW)

  it("boot order: all migrations, then ensureAllIndexes, on a fresh DB", async () => {
    if (!available) return
    await quietly(runAllMigrations)
    const warnings = await quietly(() => ensureAllIndexes(db))
    // Migrations and the registry agree on every name: no conflict warnings
    expect(warnings).toEqual([])

    const afterFirst = await snapshot()
    await quietly(() => ensureAllIndexes(db))
    expect(await snapshot()).toEqual(afterFirst)
  }, SLOW)

  it("reverse order: ensureAllIndexes, then all migrations, then ensureAllIndexes", async () => {
    if (!available) return
    await quietly(() => ensureAllIndexes(db))
    await quietly(runAllMigrations)
    const before = await snapshot()
    const warnings = await quietly(() => ensureAllIndexes(db))
    expect(warnings).toEqual([])
    expect(await snapshot()).toEqual(before)
  }, SLOW)

  it("heals a same-name index whose spec changed (billing_boost_request_unique)", async () => {
    if (!available) return
    // The pre-TER-596 spec: unique but not partial
    await db
      .collection("billing_hour_boosts")
      .createIndex({ accessRequestId: 1 }, { name: "billing_boost_request_unique", unique: true })
    await quietly(() => ensureAllIndexes(db))
    const ix = (await db.collection("billing_hour_boosts").listIndexes().toArray()).find(
      (i) => i.name === "billing_boost_request_unique",
    )
    expect(ix?.partialFilterExpression).toEqual({ accessRequestId: { $type: "string" } })
  }, SLOW)

  it("keeps an index whose unique build fell back to <name>_nonunique, without retrying", async () => {
    if (!available) return
    await db.collection("channels").insertMany([{ channelId: "ch_dup" }, { channelId: "ch_dup" }])
    const firstWarnings = await quietly(() => ensureAllIndexes(db))
    expect(firstWarnings.some((w) => w.includes("channels.channelId_1: duplicates found"))).toBe(true)

    const names = async () => (await db.collection("channels").listIndexes().toArray()).map((i) => i.name)
    expect(await names()).toContain("channelId_1_nonunique")
    expect(await names()).not.toContain("channelId_1")

    // Second boot: skipped, so no rescan and no new warning
    const secondWarnings = await quietly(() => ensureAllIndexes(db))
    expect(secondWarnings).toEqual([])
  }, SLOW)
})
