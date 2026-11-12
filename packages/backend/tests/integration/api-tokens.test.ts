/**
 * Integration test: resolveApiToken / revokeUserApiTokens (SEC-5).
 *
 * API tokens used to keep working after the user was suspended or deleted,
 * and after a password change. Every transport (WS, voice, G2, terminal) now
 * resolves tokens through resolveApiToken.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import {
  createApiToken,
  hashApiToken,
  resolveApiToken,
  revokeUserApiTokens,
} from "../../src/auth/api-tokens"
import migration from "../../src/migrations/20261017_007_hash_api_tokens"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_apitokens_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[api tokens test] Mongo unreachable — skipping")
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
  await db.collection("users").deleteMany({})
  await db.collection("api_tokens").deleteMany({})
  await db.collection("users").insertOne({ userId: "user_1", status: "active" })
  await db.collection("api_tokens").insertMany([
    {
      tokenHash: hashApiToken("tok_1"),
      tokenId: "id_tok_1",
      userId: "user_1",
      agentId: "agent_1",
      createdAt: new Date().toISOString(),
    },
    {
      tokenHash: hashApiToken("tok_2"),
      tokenId: "id_tok_2",
      userId: "user_1",
      agentId: "agent_1",
      createdAt: new Date().toISOString(),
    },
    {
      tokenHash: hashApiToken("tok_other"),
      tokenId: "id_tok_other",
      userId: "user_2",
      agentId: "agent_2",
      createdAt: new Date().toISOString(),
    },
  ])
})

describe("resolveApiToken", () => {
  it("resolves an active user's token and touches lastUsedAt", async () => {
    if (!available) return
    const doc = await resolveApiToken(db, "tok_1")

    expect(doc?.userId).toBe("user_1")
    await new Promise((r) => setTimeout(r, 50))
    expect(
      (await db.collection("api_tokens").findOne({ tokenHash: hashApiToken("tok_1") }))?.lastUsedAt,
    ).toBeString()
  })

  it("rejects unknown and empty tokens", async () => {
    if (!available) return
    expect(await resolveApiToken(db, "nope")).toBeNull()
    expect(await resolveApiToken(db, "")).toBeNull()
    expect(await resolveApiToken(db, null)).toBeNull()
  })

  it("rejects the token of a suspended user", async () => {
    if (!available) return
    await db.collection("users").updateOne({ userId: "user_1" }, { $set: { status: "suspended" } })

    expect(await resolveApiToken(db, "tok_1")).toBeNull()
  })

  it("rejects the token of a deleted user", async () => {
    if (!available) return
    await db
      .collection("users")
      .updateOne({ userId: "user_1" }, { $set: { deletedAt: new Date() } })

    expect(await resolveApiToken(db, "tok_1")).toBeNull()
  })

  it("rejects a token whose user no longer exists", async () => {
    if (!available) return
    expect(await resolveApiToken(db, "tok_other")).toBeNull()
  })
})

describe("revokeUserApiTokens", () => {
  it("deletes only that user's tokens", async () => {
    if (!available) return
    expect(await revokeUserApiTokens(db, "user_1")).toBe(2)
    expect(await db.collection("api_tokens").countDocuments({ userId: "user_1" })).toBe(0)
    expect(await db.collection("api_tokens").countDocuments({ userId: "user_2" })).toBe(1)
  })
})

describe("hashed storage (SEC-4)", () => {
  it("createApiToken stores only the hash and the token resolves", async () => {
    if (!available) return
    const { token, doc } = await createApiToken(db, {
      userId: "user_1",
      agentId: "agent_1",
      label: "glasses",
    })

    const stored = await db.collection("api_tokens").findOne({ tokenId: doc.tokenId })
    expect(JSON.stringify(stored)).not.toContain(token)
    expect((await resolveApiToken(db, token))?.tokenId).toBe(doc.tokenId)
  })

  it("rejects an expired token", async () => {
    if (!available) return
    const { token, doc } = await createApiToken(db, { userId: "user_1", agentId: "agent_1" })
    await db
      .collection("api_tokens")
      .updateOne(
        { tokenId: doc.tokenId },
        { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } },
      )

    expect(await resolveApiToken(db, token)).toBeNull()
  })

  it("the migration hashes legacy plaintext tokens, which keep working", async () => {
    if (!available) return
    await db
      .collection("api_tokens")
      .insertOne({ token: "tak_legacy", userId: "user_1", agentId: "agent_1" })

    await migration.up(db)
    await migration.up(db) // idempotent

    const legacy = await db
      .collection("api_tokens")
      .findOne({ tokenHash: hashApiToken("tak_legacy") })
    expect(legacy?.token).toBeUndefined()
    expect(legacy?.tokenId).toBeString()
    expect(legacy?.expiresAt).toBeUndefined()
    expect((await resolveApiToken(db, "tak_legacy"))?.userId).toBe("user_1")
  })
})
