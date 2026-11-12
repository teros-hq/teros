/**
 * Migration 20261109_001_teros_lanes (TLANE-REQ-6) against the private test
 * mongod (MONGODB_URI / MONGODB_DATABASE): every size's single route becomes
 * the same route on both lanes, a size that already has lanes is untouched, a
 * second run changes nothing, and `down` restores the single route.
 *
 * @spec TLANE-REQ-6
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261109_001_teros_lanes"
import { DEFAULT_TEROS_SIZE_ROUTES } from "../../src/models/providers/teros"

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27030"
const dbName = process.env.MONGODB_DATABASE ?? "teros_test_tlane"

const HELMCODE_L = { upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" }
const ALREADY = {
  interactive: { upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3", reasoningEffort: "high" },
  background: { upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" },
}

let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(uri)
  await client.connect()
  db = client.db(dbName)
  await db.dropDatabase()
  await db.collection("teros_provider_configs").insertMany([
    {
      _id: "cfg_default" as any,
      name: "Default",
      isDefault: true,
      sizes: DEFAULT_TEROS_SIZE_ROUTES,
      failover: { mode: "off", upstream: "together" },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: "cfg_eu" as any,
      name: "EU",
      isDefault: false,
      sizes: { l: ALREADY, m: DEFAULT_TEROS_SIZE_ROUTES.m, s: HELMCODE_L },
      failover: { mode: "on-error", upstream: "fireworks" },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ])
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

describe("[TLANE-AC-1] 20261109_001_teros_lanes", () => {
  it("[TLANE-AC-1] every size gets its current route on both lanes; lanes already present are kept; a second run changes nothing", async () => {
    await migration.up(db)
    const cfgs = db.collection("teros_provider_configs")
    const def = await cfgs.findOne({ _id: "cfg_default" as any })
    for (const size of ["l", "m", "s"] as const) {
      expect(def?.sizes[size]).toEqual({ interactive: DEFAULT_TEROS_SIZE_ROUTES[size], background: DEFAULT_TEROS_SIZE_ROUTES[size] })
    }
    const eu = await cfgs.findOne({ _id: "cfg_eu" as any })
    expect(eu?.sizes.l).toEqual(ALREADY)
    expect(eu?.sizes.s).toEqual({ interactive: HELMCODE_L, background: HELMCODE_L })
    expect(eu?.failover).toEqual({ mode: "on-error", upstream: "fireworks" })

    const before = await cfgs.find({}).sort({ _id: 1 }).toArray()
    await migration.up(db)
    expect(await cfgs.find({}).sort({ _id: 1 }).toArray()).toEqual(before)
  })

  it("down keeps the interactive route as the single route", async () => {
    await migration.down!(db)
    const eu = await db.collection("teros_provider_configs").findOne({ _id: "cfg_eu" as any })
    expect(eu?.sizes.l).toEqual(ALREADY.interactive)
    expect(eu?.sizes.s).toEqual(HELMCODE_L)
  })
})
