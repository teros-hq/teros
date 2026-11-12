/**
 * Unit tests for the 2-level model resolver in
 * ProviderService.resolveProviderForAgent (2026-10-21 refactor).
 *
 * Model (decision by Pablo):
 *   1. Agent pin (selectedProviderId + selectedModelId) → that exact pair.
 *   2. No pin (System Default) → the user's default provider (isDefault: true)
 *      and its defaultModelId. NO silent fallback to "first provider".
 *   3. Missing/inactive default → null + console.error (explicit, visible).
 *
 * The availableProviders list no longer exists as a concept — the resolver
 * never reads it, and orphan pins WARN (2026-09-24 silent-turn incident).
 *
 * Uses a mock Db with in-memory storage — no real MongoDB connection. The
 * billing gates (canUseTerosModel / assertAccountNotBlocked /
 * assertTerosHoursAvailable) read billing_subscriptions, billing_plans and
 * billing_invoices; the mock serves an active sub on a plan with
 * terosModel:true and agentHoursLimit 0 (unmetered) so the gates pass.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test"
import type { Db, Collection } from "mongodb"
import { ProviderService } from "./provider-service"

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/** In-memory MongoDB collection supporting the filter shapes the resolver uses. */
function createMockCollection(seed: Record<string, any>[] = []) {
  const store = new Map<string, Record<string, any>>()
  seed.forEach((doc, i) => store.set(String(doc._id ?? doc.providerId ?? doc.agentId ?? i), doc))

  const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean =>
    Object.entries(filter).every(([k, v]) => {
      // $in operator (used for provider lookups)
      if (v && typeof v === "object" && "$in" in (v as any)) {
        return (v as any).$in.includes(doc[k])
      }
      return doc[k] === v
    })

  const findOne = mock((filter: Record<string, any> = {}) => {
    const results = [...store.values()].filter((doc) => matches(doc, filter))
    return Promise.resolve(results[0] ?? null)
  })

  const find = mock((filter: Record<string, any> = {}) => {
    const results = [...store.values()].filter((doc) => matches(doc, filter))
    return Promise.resolve({
      toArray: () => Promise.resolve(results),
      sort: () => Promise.resolve(results),
    })
  })

  return {
    findOne,
    find,
    _store: store,
    insert: (doc: Record<string, any>) => store.set(String(doc._id ?? doc.providerId ?? Math.random()), doc),
  } as unknown as Collection & { _store: Map<string, any>; insert: (d: any) => void }
}

/** Mock Db: named collections, each an independent in-memory store. */
function createMockDb(docs: Record<string, Record<string, any>[]>) {
  const collections: Record<string, any> = {}
  const db = {
    collection: (name: string) => {
      if (!collections[name]) collections[name] = createMockCollection(docs[name] ?? [])
      return collections[name]
    },
  }
  return db as unknown as Db
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "user_test_owner"
const AGENT_ID = "agent_test_resolver"
const PINNED_PROVIDER_ID = "prov_pinned_alive"
const PINNED_MODEL_ID = "pinned-model-1"
const DEFAULT_PROVIDER_ID = "prov_default_alive"
const DEFAULT_MODEL_ID = "teros-glm-5p3"
const ORPHAN_PROVIDER_ID = "prov_deleted_000000"

const pinnedProviderDoc = () => ({
  providerId: PINNED_PROVIDER_ID,
  userId: USER_ID,
  // 'teros' is in PROVIDER_TYPES_WITHOUT_SECRETS — keeps the mock db free of a
  // secrets collection while still exercising the pin path end-to-end.
  providerType: "teros",
  isDefault: false,
  status: "active",
  priority: 50,
  defaultModelId: PINNED_MODEL_ID,
  models: [
    {
      modelId: PINNED_MODEL_ID,
      modelString: "glm-5.3",
      capabilities: { streaming: true, tools: true, vision: false, thinking: true },
      context: { maxTokens: 1048576, maxOutputTokens: 262144 },
    },
  ],
})

const defaultProviderDoc = () => ({
  providerId: DEFAULT_PROVIDER_ID,
  userId: USER_ID,
  providerType: "teros",
  isDefault: true,
  status: "active",
  priority: 100,
  defaultModelId: DEFAULT_MODEL_ID,
  models: [
    {
      modelId: DEFAULT_MODEL_ID,
      modelString: "accounts/fireworks/models/glm-5p3",
      capabilities: { streaming: true, tools: true, vision: false, thinking: true },
      context: { maxTokens: 1048576, maxOutputTokens: 262144 },
    },
  ],
})

const baseDocs = (agentOverrides: Record<string, any> = {}) => ({
  agents: [
    {
      agentId: AGENT_ID,
      coreId: "super-agent",
      ownerId: USER_ID,
      selectedProviderId: null,
      selectedModelId: null,
      ...agentOverrides,
    },
  ],
  agent_cores: [
    {
      coreId: "super-agent",
      modelId: "claude-opus-4-5",
      modelOverrides: { temperature: 0.7 },
      requiredCapabilities: {},
    },
  ],
  user_providers: [defaultProviderDoc(), pinnedProviderDoc()],
  billing_subscriptions: [
    {
      userId: USER_ID,
      status: "active",
      planId: "plan_test",
      agentHoursUsed: 0,
      customAgentHoursLimit: null,
    },
  ],
  billing_plans: [
    {
      _id: "plan_test",
      name: "test",
      displayName: "Test",
      description: "",
      price: 0,
      currency: "EUR",
      agentHoursLimit: 0, // unmetered → assertTerosHoursAvailable no-op
      features: { byok: true, terosModel: true, unlimitedAgents: true, maxWorkspaces: -1, prioritySupport: false },
      isPublic: false,
    },
  ],
  billing_invoices: [], // no blocking invoice → assertAccountNotBlocked no-op
  billing_hour_ledger: [],
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolveProviderForAgent — 2-level model (pin → user default)", () => {
  beforeEach(() => {
    mock.restore()
  })

  it("level 1: an agent with a pin uses exactly that provider + model", async () => {
    const svc = new ProviderService(
      createMockDb(baseDocs({ selectedProviderId: PINNED_PROVIDER_ID, selectedModelId: PINNED_MODEL_ID })),
    )
    const resolved = await svc.resolveProviderForAgent(AGENT_ID)

    expect(resolved).not.toBeNull()
    expect(resolved!.provider.providerId).toBe(PINNED_PROVIDER_ID)
    expect(resolved!.model.modelId).toBe(PINNED_MODEL_ID)
  })

  it("level 2: an agent without a pin (System Default) resolves to the USER's default provider", async () => {
    const svc = new ProviderService(createMockDb(baseDocs()))
    const resolved = await svc.resolveProviderForAgent(AGENT_ID)

    expect(resolved).not.toBeNull()
    // The user default (teros) wins — NOT the first provider by priority.
    expect(resolved!.provider.providerId).toBe(DEFAULT_PROVIDER_ID)
    expect(resolved!.model.modelId).toBe(DEFAULT_MODEL_ID)
  })

  it("level 2: System Default works regardless of any legacy availableProviders field", async () => {
    // Legacy documents may still carry the field; the resolver must ignore it.
    const svc = new ProviderService(
      createMockDb(baseDocs({ availableProviders: [PINNED_PROVIDER_ID] })),
    )
    const resolved = await svc.resolveProviderForAgent(AGENT_ID)

    expect(resolved).not.toBeNull()
    expect(resolved!.provider.providerId).toBe(DEFAULT_PROVIDER_ID)
    expect(resolved!.model.modelId).toBe(DEFAULT_MODEL_ID)
  })

  it("level 2: no user default → null + console.error, NO silent fallback to first provider", async () => {
    const errorFn = mock(() => {})
    const originalError = console.error
    console.error = errorFn as any

    try {
      const docs = baseDocs()
      // Remove the isDefault flag → the user has no default provider.
      docs.user_providers[0].isDefault = false

      const svc = new ProviderService(createMockDb(docs))
      const resolved = await svc.resolveProviderForAgent(AGENT_ID)

      expect(resolved).toBeNull()
      const errors = errorFn.mock.calls.map((c: any[]) => String(c[0]))
      expect(errors.some((e) => e.includes("no active default provider"))).toBe(true)
    } finally {
      console.error = originalError
    }
  })

  it("level 2: an inactive default provider does not resolve (no silent fallback)", async () => {
    const docs = baseDocs()
    docs.user_providers[0].status = "inactive"

    const svc = new ProviderService(createMockDb(docs))
    const resolved = await svc.resolveProviderForAgent(AGENT_ID)

    expect(resolved).toBeNull()
  })

  it("orphan pin: WARNs when selectedProviderId does not exist in user_providers", async () => {
    const warnFn = mock(() => {})
    const originalWarn = console.warn
    console.warn = warnFn as any

    try {
      const docs = baseDocs({
        agentId: "agent_test_orphan",
        selectedProviderId: ORPHAN_PROVIDER_ID,
        selectedModelId: "some-model",
      })

      const svc = new ProviderService(createMockDb(docs))
      const resolved = await svc.resolveProviderForAgent("agent_test_orphan")

      // Falls back to System Default (existing behavior preserved)…
      expect(resolved).not.toBeNull()
      expect(resolved!.provider.providerId).toBe(DEFAULT_PROVIDER_ID)

      // …but the drift is visible.
      const warns = warnFn.mock.calls.map((c: any[]) => String(c[0]))
      const orphanWarn = warns.find((w) => w.includes(ORPHAN_PROVIDER_ID))
      expect(orphanWarn).toBeDefined()
      expect(orphanWarn).toContain("agent_test_orphan")
      expect(orphanWarn).toContain("does not exist")
    } finally {
      console.warn = originalWarn
    }
  })

  it("orphan pin: dedups the WARN — a second resolve within the TTL does not warn again", async () => {
    const warnFn = mock(() => {})
    const originalWarn = console.warn
    console.warn = warnFn as any

    try {
      const docs = baseDocs({
        agentId: "agent_test_dedup",
        selectedProviderId: ORPHAN_PROVIDER_ID,
      })
      const svc = new ProviderService(createMockDb(docs))
      await svc.resolveProviderForAgent("agent_test_dedup")
      const warnsAfterFirst = warnFn.mock.calls.length
      expect(warnsAfterFirst).toBeGreaterThan(0)

      await svc.resolveProviderForAgent("agent_test_dedup")
      expect(warnFn.mock.calls.length).toBe(warnsAfterFirst) // no second WARN
    } finally {
      console.warn = originalWarn
    }
  })
})
