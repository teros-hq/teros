/**
 * Dev seed (services/dev-seed.ts): the boot auto-seed is only reachable
 * through the guarded dev auto-login state, and seedDevUser is idempotent,
 * resettable and keeps the provider key encrypted.
 *
 * The seed tests run against a throwaway database on MONGODB_URI.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, MongoClient } from "mongodb"
import { resolveDevAutologin } from "../../src/auth/dev-autologin"
import consolidateAgentCores from "../../src/migrations/20260529_001_consolidate_agent_cores"
import { secrets } from "../../src/secrets/secrets-manager"
import { DEV_SEED_EMAIL, maybeAutoSeedDevUser, seedDevUser } from "../../src/services/dev-seed"

/** A Db whose every collection access fails: proves nothing was read or written. */
const untouchableDb = {
  collection: (name: string) => {
    throw new Error(`dev seed touched ${name}`)
  },
} as unknown as Db

describe("maybeAutoSeedDevUser — never runs when the guards refuse", () => {
  const ON = { TEROS_DEV_AUTOLOGIN: "1" }
  const refused = {
    "flag off": {},
    "NODE_ENV=production": { ...ON, NODE_ENV: "production" },
    "teros.ai base URL": { ...ON, SERVER_BASE_URL: "https://app.teros.ai" },
    Kubernetes: { ...ON, KUBERNETES_SERVICE_HOST: "10.0.0.1" },
    "public BIND_HOST": { ...ON, BIND_HOST: "203.0.113.7" },
  }
  for (const [label, env] of Object.entries(refused)) {
    it(`${label} → disabled, database untouched`, async () => {
      expect(await maybeAutoSeedDevUser(untouchableDb, resolveDevAutologin(env))).toBe("disabled")
    })
  }

  it("never seeds over a TEROS_DEV_USER that names another, missing account", async () => {
    const touched: string[] = []
    const db = {
      collection: (name: string) => {
        touched.push(name)
        if (name !== "users") throw new Error(`dev seed touched ${name}`)
        return { findOne: async () => null }
      },
    } as unknown as Db
    const state = resolveDevAutologin({ ...ON, TEROS_DEV_USER: "someone@else.com" })
    expect(await maybeAutoSeedDevUser(db, state)).toBe("missing")
    expect(touched).toEqual(["users"])
  })

  it("uses an existing dev user as-is", async () => {
    const db = {
      collection: (name: string) => {
        if (name !== "users") throw new Error(`dev seed touched ${name}`)
        return { findOne: async () => ({ userId: "user_real" }) }
      },
    } as unknown as Db
    expect(await maybeAutoSeedDevUser(db, resolveDevAutologin(ON))).toBe("exists")
  })
})

// ---------------------------------------------------------------------------

const TEST_DB = `teros_test_dev_seed_${Date.now()}`
const volumesBasePath = mkdtempSync(join(tmpdir(), "dev-seed-volumes-"))
const secretsInternals = secrets as unknown as {
  loaded: boolean
  systemSecrets: Map<string, unknown>
}
let client: MongoClient
let db: Db
let originalLoaded: boolean
let originalEncryption: unknown

/** Every document the dev user owns, per collection. */
async function devFootprint(): Promise<Record<string, number>> {
  const user = await db.collection("users").findOne({ "profile.email": DEV_SEED_EMAIL })
  if (!user) return {}
  const userId = user.userId
  const ws = (await db.collection("workspaces").find({ ownerId: userId }).toArray()).map(
    (w) => w.workspaceId,
  )
  const agents = (await db.collection("agents").find({ ownerId: userId }).toArray()).map(
    (a) => a.agentId,
  )
  const channels = (await db.collection("channels").find({ userId }).toArray()).map(
    (c) => c.channelId,
  )
  const boards = (
    await db
      .collection("boards")
      .find({ workspaceId: { $in: ws } })
      .toArray()
  ).map((b) => b.boardId)
  return {
    users: await db.collection("users").countDocuments({ "profile.email": DEV_SEED_EMAIL }),
    identities: await db.collection("user_identities").countDocuments({ userId }),
    workspaces: ws.length,
    volumes: await db.collection("volumes").countDocuments({ ownerId: userId }),
    agents: agents.length,
    apps: await db.collection("apps").countDocuments({ ownerId: { $in: ws } }),
    access: await db.collection("agent_app_access").countDocuments({ agentId: { $in: agents } }),
    providers: await db.collection("user_providers").countDocuments({ userId }),
    projects: await db.collection("projects").countDocuments({ workspaceId: { $in: ws } }),
    tasks: await db.collection("tasks").countDocuments({ boardId: { $in: boards } }),
    channels: channels.length,
    messages: await db
      .collection("channel_messages")
      .countDocuments({ channelId: { $in: channels } }),
  }
}

// Tests below share one database and run in order
beforeAll(async () => {
  originalLoaded = secretsInternals.loaded
  originalEncryption = secretsInternals.systemSecrets.get("encryption")
  secretsInternals.loaded = true
  secretsInternals.systemSecrets.set("encryption", { masterKey: "b".repeat(64) })

  client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017")
  await client.connect()
  db = client.db(TEST_DB)
  await consolidateAgentCores.up(db) // the agent / super-agent cores a fresh db gets at boot
  await db
    .collection("users")
    .insertOne({ userId: "user_other", profile: { email: "other@test.com" } })
}, 120_000)

afterAll(async () => {
  await db.dropDatabase()
  rmSync(volumesBasePath, { recursive: true, force: true })
  await client.close()
  secretsInternals.loaded = originalLoaded
  if (originalEncryption) secretsInternals.systemSecrets.set("encryption", originalEncryption)
  else secretsInternals.systemSecrets.delete("encryption")
})

describe("seedDevUser (MongoDB) — auto-seed and idempotency", () => {
  it("boot auto-seed creates a functional dev@teros.local on a fresh db", async () => {
    const state = resolveDevAutologin({ TEROS_DEV_AUTOLOGIN: "1" })
    expect(await maybeAutoSeedDevUser(db, state, { volumesBasePath })).toBe("seeded")

    const user = await db.collection("users").findOne({ "profile.email": DEV_SEED_EMAIL })
    expect(user).toMatchObject({
      role: "super",
      emailVerified: true,
      accessGranted: true,
      status: "active",
    })
    expect(user?.onboardingCompletedAt).toBeTruthy()
    expect(user?.lastChangelogSeen).toBeTruthy() // no "What's New" carousel over the landing

    const footprint = await devFootprint()
    expect(footprint).toMatchObject({
      identities: 1,
      workspaces: 2,
      agents: 3,
      projects: 1,
      tasks: 7,
      channels: 3,
    })
    expect(footprint.apps).toBeGreaterThan(4)
    expect(footprint.messages).toBeGreaterThan(6)

    const agentNames = (
      await db.collection("agents").find({ ownerId: user?.userId }).toArray()
    ).map((a) => a.name)
    expect(agentNames.sort()).toEqual(["Ada", "Atlas", "Iria"])
    const mcaIds = new Set((await db.collection("apps").find({}).toArray()).map((a) => a.mcaId))
    for (const mcaId of [
      "mca.teros.filesystem",
      "mca.teros.bash",
      "mca.teros.messaging",
      "mca.teros.todo-list",
    ]) {
      expect(mcaIds.has(mcaId)).toBe(true)
    }

    expect(await maybeAutoSeedDevUser(db, state, { volumesBasePath })).toBe("exists")
  }, 120_000)

  it("re-running fills nothing twice", async () => {
    const before = await devFootprint()
    const report = await seedDevUser(db, { volumesBasePath })
    await seedDevUser(db, { volumesBasePath })
    expect(report.createdUser).toBe(false)
    expect(await devFootprint()).toEqual(before)
  }, 120_000)
})

describe("seedDevUser (MongoDB) — provider", () => {
  it("wires the provider from DEV_SEED_PROVIDER_KEY, encrypted, and points the agents at it", async () => {
    const env = {
      DEV_SEED_PROVIDER_KEY: "sk-dev-seed-test-key",
      // Unreachable: model discovery falls back to the pinned model, no network
      DEV_SEED_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
    }
    expect((await seedDevUser(db, { env, volumesBasePath })).provider).toBe("configured")
    await seedDevUser(db, { env, volumesBasePath })

    const user = await db.collection("users").findOne({ "profile.email": DEV_SEED_EMAIL })
    const provider = await db
      .collection("user_providers")
      .findOne({ userId: user?.userId, providerType: "openai-compatible" })
    expect(provider).toMatchObject({
      status: "active",
      defaultModelId: "openai-compatible-qwen3-6",
    })
    expect(provider?.encryptedData).toBeTruthy()
    expect(JSON.stringify(provider)).not.toContain("sk-dev-seed-test-key")
    expect(
      await db
        .collection("user_providers")
        .countDocuments({ userId: user?.userId, providerType: "openai-compatible" }),
    ).toBe(1)

    const agents = await db.collection("agents").find({ ownerId: user?.userId }).toArray()
    for (const agent of agents) {
      expect(agent.availableProviders).toEqual([provider?.providerId])
      expect(agent.selectedModelId).toBe("openai-compatible-qwen3-6")
    }
  }, 120_000)
})

describe("seedDevUser (MongoDB) — reset", () => {
  it("reset recreates only the dev user's artifacts", async () => {
    const oldUser = await db.collection("users").findOne({ "profile.email": DEV_SEED_EMAIL })
    const catalog = await db.collection("mca_catalog").countDocuments()

    const report = await seedDevUser(db, { reset: true, volumesBasePath })
    expect(report.createdUser).toBe(true)
    expect(report.userId).not.toBe(oldUser?.userId)

    for (const name of [
      "users",
      "workspaces",
      "agents",
      "channels",
      "user_providers",
      "user_identities",
    ]) {
      const owned = await db
        .collection(name)
        .countDocuments({ $or: [{ userId: oldUser?.userId }, { ownerId: oldUser?.userId }] })
      expect(owned).toBe(0)
    }
    expect(await db.collection("users").countDocuments({ userId: "user_other" })).toBe(1)
    expect(await db.collection("mca_catalog").countDocuments()).toBe(catalog)
    expect(await devFootprint()).toMatchObject({
      users: 1,
      workspaces: 2,
      agents: 3,
      tasks: 7,
      channels: 3,
    })
  }, 120_000)
})
