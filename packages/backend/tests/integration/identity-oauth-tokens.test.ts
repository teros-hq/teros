/**
 * Integration test: OAuth provider tokens are not kept on identities (SEC-4).
 *
 * They were stored in plaintext and never read back. Uses MONGODB_URI
 * (default local :27017) with a unique db name that is dropped afterwards.
 * Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { IdentityService } from "../../src/auth/identity-service"
import migration from "../../src/migrations/20261017_006_drop_identity_oauth_tokens"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_idtokens_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[identity oauth tokens test] Mongo unreachable — skipping")
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

describe("OAuth identity tokens", () => {
  it("are removed from an existing identity on the next sign-in", async () => {
    if (!available) return
    await db.collection("user_identities").insertOne({
      userId: "u1",
      type: "google",
      providerUserId: "g1",
      email: "dana@example.com",
      status: "active",
      data: { accessToken: "ya29.secret", refreshToken: "1//secret", providerProfile: {} },
    })

    await new IdentityService(db).upsertOAuthIdentity({
      userId: "u1",
      type: "google",
      providerUserId: "g1",
      email: "dana@example.com",
      providerProfile: { email: "dana@example.com" },
    })

    const data = (await db.collection("user_identities").findOne({ providerUserId: "g1" }))?.data
    expect(data?.accessToken).toBeUndefined()
    expect(data?.refreshToken).toBeUndefined()
  })

  it("the migration strips them from every identity", async () => {
    if (!available) return
    await db.collection("user_identities").insertMany([
      { type: "google", data: { accessToken: "a", refreshToken: "r", tokenExpiresAt: new Date() } },
      { type: "password", data: { passwordHash: "h" } },
    ])

    await migration.up(db)

    expect(
      await db
        .collection("user_identities")
        .countDocuments({ "data.accessToken": { $exists: true } }),
    ).toBe(0)
    expect(
      await db.collection("user_identities").countDocuments({ "data.passwordHash": "h" }),
    ).toBe(1)
  })
})
