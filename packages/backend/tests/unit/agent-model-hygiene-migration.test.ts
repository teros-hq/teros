/**
 * 20261017_001_agent_model_hygiene migration (spec 20261017_agent-model-tools).
 *
 * Pins the three repairs against the in-memory Mongo:
 *   1. Teros provider defaultModelId remapped to teros-glm-5p3 (decision D1) —
 *      from teros-kimi-k3 and from the reserved teros-glm-5p3-fast.
 *   2. Legacy preferredProviderId collapsed into selectedProviderId (modern
 *      field wins when both exist) and the legacy field removed.
 *   3. Orphan pins cleaned: dead availableProviders dropped, selectedProviderId
 *      pointing at a dead/unavailable provider cleared, selectedModelId not
 *      served by any available provider cleared.
 *
 * Mutation-checked: dropping any of the three steps turns its assertions red.
 */

import { describe, expect, it } from "bun:test"
import migration from "../../src/migrations/20261017_001_agent_model_hygiene"
import { InMemoryDb } from "./_stripe-test-helpers"

function terosProvider(providerId: string, defaultModelId: string) {
  return {
    providerId,
    userId: "user_1",
    providerType: "teros",
    displayName: "Teros",
    models: [
      { modelId: "teros-kimi-k3", capabilities: {} },
      { modelId: "teros-glm-5p3", capabilities: {} },
      { modelId: "teros-glm-5p3-fast", capabilities: {} },
    ],
    defaultModelId,
    isDefault: true,
    priority: 100,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
  }
}

describe("20261017_001_agent_model_hygiene", () => {
  it("remaps the Teros default to teros-glm-5p3 (D1)", async () => {
    const db = new InMemoryDb()
    await db.collection("user_providers").insertOne(terosProvider("prov_a", "teros-kimi-k3"))
    await db.collection("user_providers").insertOne(terosProvider("prov_b", "teros-glm-5p3-fast"))
    await db.collection("user_providers").insertOne(terosProvider("prov_c", "teros-glm-5p3"))

    await migration.up(db as any)

    const a = await db.collection("user_providers").findOne({ providerId: "prov_a" })
    const b = await db.collection("user_providers").findOne({ providerId: "prov_b" })
    const c = await db.collection("user_providers").findOne({ providerId: "prov_c" })
    expect(a?.defaultModelId).toBe("teros-glm-5p3")
    expect(b?.defaultModelId).toBe("teros-glm-5p3")
    expect(c?.defaultModelId).toBe("teros-glm-5p3")
  })

  it("collapses preferredProviderId into selectedProviderId (modern wins)", async () => {
    const db = new InMemoryDb()
    await db.collection("user_providers").insertOne(terosProvider("prov_a", "teros-glm-5p3"))
    // Legacy only → copied.
    await db.collection("agents").insertOne({
      agentId: "agent_legacy",
      ownerId: "user_1",
      availableProviders: ["prov_a"],
      preferredProviderId: "prov_a",
    })
    // Both → modern wins, legacy dropped.
    await db.collection("agents").insertOne({
      agentId: "agent_both",
      ownerId: "user_1",
      availableProviders: ["prov_a"],
      preferredProviderId: "prov_dead",
      selectedProviderId: "prov_a",
    })

    await migration.up(db as any)

    const legacy = await db.collection("agents").findOne({ agentId: "agent_legacy" })
    expect(legacy?.selectedProviderId).toBe("prov_a")
    expect(legacy?.preferredProviderId).toBeUndefined()

    const both = await db.collection("agents").findOne({ agentId: "agent_both" })
    expect(both?.selectedProviderId).toBe("prov_a")
    expect(both?.preferredProviderId).toBeUndefined()
  })

  it("cleans orphan pins (dead provider, unavailable selection, ghost model)", async () => {
    const db = new InMemoryDb()
    await db.collection("user_providers").insertOne(terosProvider("prov_live", "teros-glm-5p3"))

    // Dead provider in availableProviders + ghost model pin.
    await db.collection("agents").insertOne({
      agentId: "agent_orphan",
      ownerId: "user_1",
      availableProviders: ["prov_dead"],
      selectedProviderId: "prov_dead",
      selectedModelId: "openrouter-claude-sonnet-4-6",
    })
    // Healthy agent — untouched.
    await db.collection("agents").insertOne({
      agentId: "agent_healthy",
      ownerId: "user_1",
      availableProviders: ["prov_live"],
      selectedProviderId: "prov_live",
      selectedModelId: "teros-glm-5p3",
    })

    await migration.up(db as any)

    const orphan = await db.collection("agents").findOne({ agentId: "agent_orphan" })
    expect(orphan?.availableProviders).toEqual([])
    expect(orphan?.selectedProviderId).toBeNull()
    expect(orphan?.selectedModelId).toBeNull()

    const healthy = await db.collection("agents").findOne({ agentId: "agent_healthy" })
    expect(healthy?.availableProviders).toEqual(["prov_live"])
    expect(healthy?.selectedProviderId).toBe("prov_live")
    expect(healthy?.selectedModelId).toBe("teros-glm-5p3")
  })

  it("is idempotent — a second run changes nothing", async () => {
    const db = new InMemoryDb()
    await db.collection("user_providers").insertOne(terosProvider("prov_a", "teros-kimi-k3"))
    await db.collection("agents").insertOne({
      agentId: "agent_1",
      ownerId: "user_1",
      availableProviders: ["prov_a"],
      preferredProviderId: "prov_a",
    })

    await migration.up(db as any)
    await migration.up(db as any)

    const provider = await db.collection("user_providers").findOne({ providerId: "prov_a" })
    expect(provider?.defaultModelId).toBe("teros-glm-5p3")
    const agent = await db.collection("agents").findOne({ agentId: "agent_1" })
    expect(agent?.selectedProviderId).toBe("prov_a")
    expect(agent?.preferredProviderId).toBeUndefined()
  })
})
