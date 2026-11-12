/**
 * Migration 20261103_001_teros_sizes (TPROV-REQ-12) against the private test
 * mongod (MONGODB_URI / MONGODB_DATABASE): configs get size routes, the models
 * catalogue carries the sizes, teros snapshots and pins move to sizes, and a
 * second run changes nothing.
 *
 * @spec TPROV-REQ-12
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261103_001_teros_sizes"
import { DEFAULT_TEROS_SIZE_ROUTES, DEFAULT_TEROS_SIZES } from "../../src/models/providers/teros"

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27030"
const dbName = process.env.MONGODB_DATABASE ?? "teros_test_tprov"

let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(uri)
  await client.connect()
  db = client.db(dbName)
  await db.dropDatabase()
  await db.collection("teros_provider_configs").insertMany([
    { _id: "cfg_default" as any, name: "Default", fireworksApiKey: "x", isDefault: true, createdAt: new Date(), updatedAt: new Date() },
    { _id: "cfg_eu" as any, name: "EU", fireworksApiKey: "y", isDefault: false, createdAt: new Date(), updatedAt: new Date() },
  ])
  await db.collection("models").insertMany([
    { modelId: "teros-glm-5p3", provider: "teros", name: "GLM-5.3", modelString: "accounts/fireworks/models/glm-5p3", status: "active" },
    { modelId: "teros-glm-5p3-flash", provider: "teros", name: "GLM-5.3 Flash", modelString: "accounts/fireworks/models/glm-5p3-flash", status: "active" },
    { modelId: "fireworks-glm-5p3", provider: "fireworks", name: "GLM-5.3", modelString: "accounts/fireworks/models/glm-5p3", status: "active" },
  ])
  await db.collection("user_providers").insertMany([
    { providerId: "prov_a", userId: "alice", providerType: "teros", models: [{ modelId: "teros-glm-5p3", modelString: "x", capabilities: {} }], defaultModelId: "teros-glm-5p3" },
    { providerId: "prov_b", userId: "bob", providerType: "teros", models: [{ modelId: "teros-deepseek-v4p1-flash", modelString: "x", capabilities: {} }], defaultModelId: "teros-deepseek-v4p1-flash" },
    { providerId: "prov_c", userId: "carol", providerType: "anthropic", models: [{ modelId: "claude", modelString: "claude", capabilities: {} }], defaultModelId: "claude" },
  ])
  await db.collection("agents").insertMany([
    { agentId: "ag_1", selectedModelId: "teros-glm-5p3-flash" },
    { agentId: "ag_2", selectedModelId: "teros-kimi-k3" },
    { agentId: "ag_3", selectedModelId: "claude" },
    { agentId: "ag_4" },
  ])
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

describe("[TPROV-AC-1] 20261103_001_teros_sizes", () => {
  it("[TPROV-AC-1] writes today's Fireworks reality into every config, sizes into the catalogue, snapshots and pins", async () => {
    await migration.up(db)

    const cfgs = await db.collection("teros_provider_configs").find({}).toArray()
    for (const c of cfgs) {
      expect(c.sizes).toEqual(DEFAULT_TEROS_SIZE_ROUTES)
      expect(c.failover).toEqual(DEFAULT_TEROS_SIZES.failover)
    }

    const teros = await db.collection("models").find({ provider: "teros" }).toArray()
    const active = teros.filter((m) => m.status === "active").map((m) => m.modelId).sort()
    expect(active).toEqual(["teros-l", "teros-m", "teros-s"])
    expect(teros.find((m) => m.modelId === "teros-glm-5p3")?.status).toBe("deprecated")
    expect((await db.collection("models").findOne({ modelId: "fireworks-glm-5p3" }))?.status).toBe("active")

    const a = await db.collection("user_providers").findOne({ providerId: "prov_a" })
    expect(a?.models.map((m: any) => m.modelId)).toEqual(["teros-l", "teros-m", "teros-s"])
    expect(a?.models[0].name).toBe("Model L")
    expect(a?.defaultModelId).toBe("teros-l")
    const b = await db.collection("user_providers").findOne({ providerId: "prov_b" })
    expect(b?.defaultModelId).toBe("teros-s")
    const c = await db.collection("user_providers").findOne({ providerId: "prov_c" })
    expect(c?.defaultModelId).toBe("claude")
    expect(c?.models[0].modelId).toBe("claude")

    expect((await db.collection("agents").findOne({ agentId: "ag_1" }))?.selectedModelId).toBe("teros-m")
    expect((await db.collection("agents").findOne({ agentId: "ag_2" }))?.selectedModelId).toBe("teros-l")
    expect((await db.collection("agents").findOne({ agentId: "ag_3" }))?.selectedModelId).toBe("claude")
    expect((await db.collection("agents").findOne({ agentId: "ag_4" }))?.selectedModelId).toBeUndefined()
  })

  it("[TPROV-AC-1] is idempotent and keeps an admin's later edits", async () => {
    await db.collection("teros_provider_configs").updateOne(
      { _id: "cfg_eu" as any },
      { $set: { "sizes.l": { upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" } } },
    )
    const before = await db.collection("user_providers").find({}).toArray()
    await migration.up(db)
    const eu = await db.collection("teros_provider_configs").findOne({ _id: "cfg_eu" as any })
    expect(eu?.sizes.l.upstream).toBe("helmcode")
    const after = await db.collection("user_providers").find({}).toArray()
    expect(after.map((p) => [p.providerId, p.defaultModelId, p.models.map((m: any) => m.modelId)])).toEqual(
      before.map((p) => [p.providerId, p.defaultModelId, p.models.map((m: any) => m.modelId)]),
    )
    expect((await db.collection("models").countDocuments({ provider: "teros", status: "active" }))).toBe(3)
  })
})
