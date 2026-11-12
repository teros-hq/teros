/**
 * Integration test: 20261017_009_encrypt_totp_secrets (SEC-4).
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down. The system key is injected.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { MFAService } from "../../src/auth/mfa-service"
import { generateTOTP, generateTOTPSecret } from "../../src/auth/totp"
import migration from "../../src/migrations/20261017_009_encrypt_totp_secrets"
import { secrets } from "../../src/secrets/secrets-manager"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_totpmig_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
const internals = secrets as unknown as { loaded: boolean; systemSecrets: Map<string, unknown> }

beforeAll(async () => {
  internals.loaded = true
  if (!internals.systemSecrets.has("encryption")) {
    internals.systemSecrets.set("encryption", { masterKey: randomBytes(32).toString("hex") })
  }
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[totp migration test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

describe("20261017_009_encrypt_totp_secrets", () => {
  it("encrypts plaintext secrets, which keep verifying", async () => {
    if (!available) return
    const secret = generateTOTPSecret()
    await db.collection("users").insertOne({
      userId: "u1",
      profile: { email: "u1@example.com" },
      mfa: { enabled: true, secret, backupCodeHashes: [], backupCodesRemaining: 0 },
    })

    await migration.up(db)
    await migration.up(db) // idempotent

    const user = await db.collection("users").findOne({ userId: "u1" })
    expect(user?.mfa.secret).toBeUndefined()
    expect(JSON.stringify(user)).not.toContain(secret)
    expect((await new MFAService(db).verifyMFA("u1", generateTOTP(secret))).success).toBe(true)
  })
})
