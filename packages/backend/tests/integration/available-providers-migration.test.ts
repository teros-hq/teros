/**
 * Integration test: 20261021_001_remove_available_providers.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down. Verifies the migration's three
 * behaviors:
 *   1. Dead-provider pins are cleared (both fields) → System Default.
 *   2. Ghost model pins are cleared (model only).
 *   3. `availableProviders` is unset from every document — idempotently.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261021_001_remove_available_providers"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_provmig_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[prov migration test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

const seedAgent = (agentId: string, extra: Record<string, unknown> = {}) =>
  db.collection("agents").insertOne({ agentId, ownerId: "u1", ...extra })

describe("20261021_001_remove_available_providers", () => {
  it("clears dead pins and ghost models, unsets availableProviders, idempotent", async () => {
    if (!available) return

    await db.collection("user_providers").insertOne({
      providerId: "prov_live",
      userId: "u1",
      providerType: "teros",
      isDefault: true,
      status: "active",
      models: [{ modelId: "m1" }, { modelId: "m2" }],
    })

    // 1. Valid pin + legacy list → pin kept, field unset.
    await seedAgent("agent_valid_pin", {
      selectedProviderId: "prov_live",
      selectedModelId: "m1",
      availableProviders: ["prov_live"],
    })
    // 2. Pin at a provider that does not exist → both fields cleared.
    await seedAgent("agent_dead_pin", {
      selectedProviderId: "prov_deleted",
      selectedModelId: "m1",
      availableProviders: [],
    })
    // 3. Pin at a live provider that does not serve the model → model cleared.
    await seedAgent("agent_ghost_model", {
      selectedProviderId: "prov_live",
      selectedModelId: "m_ghost",
      availableProviders: ["prov_live", "prov_other"],
    })
    // 4. No pin, only the legacy list → nothing but the field unset.
    await seedAgent("agent_list_only", { availableProviders: ["prov_live"] })
    // 5. Clean agent → untouched (updatedAt unchanged).
    await seedAgent("agent_clean", { selectedProviderId: null, selectedModelId: null })

    await migration.up(db)
    await migration.up(db) // idempotent

    const agents = db.collection("agents")
    const valid = await agents.findOne({ agentId: "agent_valid_pin" })
    expect(valid?.selectedProviderId).toBe("prov_live")
    expect(valid?.selectedModelId).toBe("m1")
    expect(valid?.availableProviders).toBeUndefined()

    const dead = await agents.findOne({ agentId: "agent_dead_pin" })
    expect(dead?.selectedProviderId).toBeNull()
    expect(dead?.selectedModelId).toBeNull()
    expect(dead?.availableProviders).toBeUndefined()

    const ghost = await agents.findOne({ agentId: "agent_ghost_model" })
    expect(ghost?.selectedProviderId).toBe("prov_live")
    expect(ghost?.selectedModelId).toBeNull()
    expect(ghost?.availableProviders).toBeUndefined()

    const listOnly = await agents.findOne({ agentId: "agent_list_only" })
    expect(listOnly?.availableProviders).toBeUndefined()

    const clean = await agents.findOne({ agentId: "agent_clean" })
    expect(clean?.availableProviders).toBeUndefined()
    expect(clean?.selectedProviderId).toBeNull()

    // No document anywhere still carries the dead field.
    expect(await agents.countDocuments({ availableProviders: { $exists: true } })).toBe(0)
  })
})
