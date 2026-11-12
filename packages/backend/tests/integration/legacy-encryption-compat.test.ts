/**
 * Integration test: secrets written by the code before GOV-7 / SEC-4 (dev at
 * 58fd327d4) still decrypt with the current code.
 *
 * The fixtures below reproduce byte for byte what the old AuthManager /
 * ProviderService stored: user keys wrapped with the system masterKey as
 * data‖iv‖tag hex (keyVersion 1, plus an unused salt), and credentials /
 * provider secrets encrypted with the user key WITHOUT AAD and without an
 * encryptionFormat marker.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { type Db, MongoClient, ObjectId } from "mongodb"
import { AuthManager } from "../../src/auth/auth-manager"
import { encrypt } from "../../src/auth/encryption"
import { AAD_FORMAT } from "../../src/auth/user-keys"
import { secrets } from "../../src/secrets/secrets-manager"
import { ProviderService } from "../../src/services/provider-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_legacycrypto_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
const SYSTEM_KEY = randomBytes(32)
const internals = secrets as unknown as { loaded: boolean; systemSecrets: Map<string, unknown> }
let originalEncryption: unknown
let originalLoaded: boolean

/** The old wrap: encrypt(userKeyHex, systemKey) → data‖iv‖tag as hex. */
function oldWrap(userKey: Buffer): string {
  const e = encrypt(userKey.toString("hex"), SYSTEM_KEY)
  return Buffer.concat([Buffer.from(e.data, "hex"), Buffer.from(e.iv, "hex"), Buffer.from(e.tag, "hex")]).toString("hex")
}

async function seedOldUserKey(userId: string): Promise<Buffer> {
  const userKey = randomBytes(32)
  await db.collection("user_encryption_keys").insertOne({
    _id: new ObjectId(),
    userId,
    encryptedMasterKey: oldWrap(userKey),
    keyVersion: 1,
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date(),
  })
  return userKey
}

beforeAll(async () => {
  originalLoaded = internals.loaded
  originalEncryption = internals.systemSecrets.get("encryption")
  internals.loaded = true
  internals.systemSecrets.set("encryption", { masterKey: SYSTEM_KEY.toString("hex") })
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[legacy encryption compat test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  internals.loaded = originalLoaded
  if (originalEncryption) internals.systemSecrets.set("encryption", originalEncryption)
  else internals.systemSecrets.delete("encryption")
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

describe("secrets stored by the old code", () => {
  it("app credentials (user_credentials) decrypt, and a merge re-encrypts them with AAD", async () => {
    if (!available) return
    const userKey = await seedOldUserKey("u_cred")
    const e = encrypt({ accessToken: "old-at", refreshToken: "old-rt" }, userKey)
    await db.collection("user_credentials").insertOne({
      userId: "u_cred",
      appId: "app_gmail",
      mcaId: "mca.google.gmail",
      encryptedData: e.data,
      encryptionIv: e.iv,
      encryptionTag: e.tag,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const auth = new AuthManager(db)
    expect(await auth.get("u_cred", "app_gmail")).toEqual({ accessToken: "old-at", refreshToken: "old-rt" })

    await auth.merge("u_cred", "app_gmail", "mca.google.gmail", { accessToken: "new-at" })
    expect(await auth.get("u_cred", "app_gmail")).toEqual({ accessToken: "new-at", refreshToken: "old-rt" })
    const doc = await db.collection("user_credentials").findOne({ userId: "u_cred", appId: "app_gmail" })
    expect(doc?.encryptionFormat).toBe(AAD_FORMAT)
  })

  it("provider API keys (user_providers) decrypt", async () => {
    if (!available) return
    const userKey = await seedOldUserKey("u_prov")
    const e = encrypt({ apiKey: "sk-old-key" }, userKey)
    await db.collection("user_providers").insertOne({
      providerId: "prov_1",
      userId: "u_prov",
      providerType: "anthropic",
      displayName: "Anthropic",
      encryptedData: e.data,
      encryptionIv: e.iv,
      encryptionTag: e.tag,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const svc = new ProviderService(db)
    expect(await svc.getProviderSecrets("u_prov", "prov_1")).toEqual({ apiKey: "sk-old-key" })
  })

  // app_user_auth (plaintext legacy auth) was dropped with apps v2.2 (e8cbd5017,
  // migration 20261102_003) — nothing left to read.

  it("the same user key keeps working for new secrets written after the upgrade", async () => {
    if (!available) return
    await seedOldUserKey("u_mixed")
    const auth = new AuthManager(db)
    await auth.set("u_mixed", "app_new", "mca.new", { k: "v" })
    expect(await auth.get("u_mixed", "app_new")).toEqual({ k: "v" })
    // No second key was created for the user
    expect(await db.collection("user_encryption_keys").countDocuments({ userId: "u_mixed" })).toBe(1)
  })
})
