/**
 * Default Teros provider provisioning (fix for the simplified-onboarding regression).
 *
 * The simplified onboarding (PR #308) removed the provider-selection step — the
 * only place a user obtained a provider — so new users ended up with zero
 * `user_providers`. Their default agent (`availableProviders: []`) then failed to
 * resolve an LLM and the chat threw "No AI provider is configured".
 *
 * These tests pin the three layers of the fix against a faithful in-memory Mongo:
 *   1. ProviderService.ensureDefaultTerosProvider — the credential-free provider.
 *   2. UserService.createUser — provisions it on signup (the path that broke).
 *   3. The backfill migration — repairs already-affected accounts, conservatively.
 *
 * Mutation-checked: removing the createUser call, dropping `isDefault`, leaving
 * `models` empty, or widening the backfill filter each turns one of these red.
 */

import { describe, expect, it } from "bun:test"
import { UserService } from "../../src/auth/user-service"
import backfillMigration from "../../src/migrations/20260630_001_backfill_default_teros_provider"
import { ProviderService } from "../../src/services/provider-service"
import { InMemoryDb } from "./_stripe-test-helpers"

const TEROS_BASE_MODEL = "teros-kimi-k2.6"

describe("ProviderService.ensureDefaultTerosProvider", () => {
  it("provisions a credential-free Teros default with catalogue models", async () => {
    const db = new InMemoryDb()
    const svc = new ProviderService(db as any)

    const provider = await svc.ensureDefaultTerosProvider("user_1")

    // Exact shape the resolver depends on.
    expect(provider.providerType).toBe("teros")
    expect(provider.displayName).toBe("Teros")
    expect(provider.status).toBe("active")
    expect(provider.isDefault).toBe(true)
    expect(provider.userId).toBe("user_1")

    // Models must be populated from the static catalogue, or
    // resolveModelFromProviders skips a provider with `models.length === 0`.
    expect(provider.models.length).toBeGreaterThan(0)
    const modelIds = provider.models.map((m) => m.modelId)
    expect(modelIds).toContain(TEROS_BASE_MODEL)
    // defaultModelId is the first catalogue model (what Step 2 falls back to).
    expect(provider.defaultModelId).toBe(provider.models[0]?.modelId)

    // Persisted, queryable as the user's default.
    const stored = await db
      .collection("user_providers")
      .findOne({ userId: "user_1", providerType: "teros" })
    expect(stored?.isDefault).toBe(true)
  })

  it("is idempotent — a second call never creates a second Teros provider", async () => {
    const db = new InMemoryDb()
    const svc = new ProviderService(db as any)

    const first = await svc.ensureDefaultTerosProvider("user_1")
    const second = await svc.ensureDefaultTerosProvider("user_1")

    expect(second.providerId).toBe(first.providerId)
    const all = await db.collection("user_providers").find({ userId: "user_1" }).toArray()
    expect(all.length).toBe(1)
  })

  it("does not steal the default slot from a provider the user already chose", async () => {
    const db = new InMemoryDb()
    const svc = new ProviderService(db as any)

    // User connected a BYOK provider and made it their default.
    await db.collection("user_providers").insertOne({
      providerId: "prov_byok",
      userId: "user_1",
      providerType: "anthropic",
      displayName: "Anthropic",
      models: [{ modelId: "claude", modelString: "claude", capabilities: {} }],
      isDefault: true,
      priority: 100,
      status: "active",
      createdAt: "t",
      updatedAt: "t",
    })

    const teros = await svc.ensureDefaultTerosProvider("user_1")

    // Teros is added but NOT promoted over the user's explicit default.
    expect(teros.isDefault).toBe(false)
    const byok = await db.collection("user_providers").findOne({ providerId: "prov_byok" })
    expect(byok?.isDefault).toBe(true)
  })
})

describe("UserService.createUser — Teros provisioning on signup", () => {
  it("provisions the default Teros provider for a new user", async () => {
    const db = new InMemoryDb()
    const userService = new UserService(db as any)
    userService.setProviderService(new ProviderService(db as any))

    const user = await userService.createUser({
      email: "New.User@Example.com",
      displayName: "New User",
    })

    const provider = await db
      .collection("user_providers")
      .findOne({ userId: user.userId, providerType: "teros" })

    expect(provider).not.toBeNull()
    expect(provider?.isDefault).toBe(true)
    expect(provider?.status).toBe("active")
    expect(provider?.models.length).toBeGreaterThan(0)
  })

  it("does not crash signup when the ProviderService is unavailable", async () => {
    const db = new InMemoryDb()
    const userService = new UserService(db as any)
    // No setProviderService — late binding never happened.

    const user = await userService.createUser({
      email: "noprov@example.com",
      displayName: "No Prov",
    })

    // User is still created; provider provisioning is best-effort, not required.
    expect(user.userId).toBeTruthy()
    const provider = await db
      .collection("user_providers")
      .findOne({ userId: user.userId, providerType: "teros" })
    expect(provider).toBeNull()
  })
})

describe("backfill migration — repair users with no provider", () => {
  it("provisions Teros only for users with zero providers", async () => {
    const db = new InMemoryDb()

    // Affected: signed up after the onboarding change, no provider at all.
    await db.collection("users").insertOne({ userId: "user_broken" })
    // Healthy: already connected a BYOK provider.
    await db.collection("users").insertOne({ userId: "user_byok" })
    await db.collection("user_providers").insertOne({
      providerId: "prov_byok",
      userId: "user_byok",
      providerType: "anthropic",
      displayName: "Anthropic",
      models: [],
      isDefault: true,
      priority: 100,
      status: "active",
      createdAt: "t",
      updatedAt: "t",
    })

    await backfillMigration.up(db as any)

    // Broken user repaired with a default Teros provider.
    const repaired = await db
      .collection("user_providers")
      .findOne({ userId: "user_broken", providerType: "teros" })
    expect(repaired?.isDefault).toBe(true)
    expect(repaired?.models.length).toBeGreaterThan(0)

    // BYOK user left untouched — no Teros provider injected.
    const byokTeros = await db
      .collection("user_providers")
      .findOne({ userId: "user_byok", providerType: "teros" })
    expect(byokTeros).toBeNull()
    const byokProviders = await db
      .collection("user_providers")
      .find({ userId: "user_byok" })
      .toArray()
    expect(byokProviders.length).toBe(1)
  })

  it("is idempotent — a second run provisions nothing new", async () => {
    const db = new InMemoryDb()
    await db.collection("users").insertOne({ userId: "user_broken" })

    await backfillMigration.up(db as any)
    await backfillMigration.up(db as any)

    const providers = await db
      .collection("user_providers")
      .find({ userId: "user_broken" })
      .toArray()
    expect(providers.length).toBe(1)
    expect(providers[0]?.providerType).toBe("teros")
  })
})
