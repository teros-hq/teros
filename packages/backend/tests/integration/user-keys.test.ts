/**
 * Integration test: per-user key management (GOV-7) and AuthManager.merge
 * concurrency (MOD-6).
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down. The system key is injected into
 * the secrets manager (no .secrets needed).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { AuthManager } from "../../src/auth/auth-manager"
import { encrypt } from "../../src/auth/encryption"
import {
  AAD_FORMAT,
  decryptForUser,
  encryptForUser,
  getUserKey,
  rewrapUserKeys,
} from "../../src/auth/user-keys"
import { secrets } from "../../src/secrets/secrets-manager"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_userkeys_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
const V1 = randomBytes(32).toString("hex")
const V2 = randomBytes(32).toString("hex")
const internals = secrets as unknown as { loaded: boolean; systemSecrets: Map<string, unknown> }
let originalEncryption: unknown
let originalLoaded: boolean

beforeAll(async () => {
  originalLoaded = internals.loaded
  originalEncryption = internals.systemSecrets.get("encryption")
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[user keys test] Mongo unreachable — skipping")
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

beforeEach(async () => {
  internals.loaded = true
  internals.systemSecrets.set("encryption", { masterKey: V1 })
  if (!available) return
  await db.dropDatabase()
  await db.collection("user_encryption_keys").createIndex({ userId: 1 }, { unique: true })
  await db.collection("user_credentials").createIndex({ userId: 1, appId: 1 }, { unique: true })
})

describe("user-keys", () => {
  it("creates one wrapped key per user, without the unused salt", async () => {
    if (!available) return
    const [a, b] = await Promise.all([getUserKey(db, "u1"), getUserKey(db, "u1")])

    expect(a.equals(b)).toBe(true) // concurrent first use agrees on one key
    const doc = await db.collection("user_encryption_keys").findOne({ userId: "u1" })
    expect(doc?.keyVersion).toBe(1)
    expect(doc?.salt).toBeUndefined()
    expect(doc?.encryptedMasterKey).not.toContain(a.toString("hex"))
  })

  it("binds ciphertext to its user and scope (AAD)", async () => {
    if (!available) return
    const enc = await encryptForUser(db, "u1", "user_credentials:app1", { token: "secret" })

    expect(await decryptForUser(db, "u1", "user_credentials:app1", enc, AAD_FORMAT)).toEqual({
      token: "secret",
    })
    await expect(
      decryptForUser(db, "u1", "user_credentials:app2", enc, AAD_FORMAT),
    ).rejects.toThrow()
  })

  it("still reads data encrypted before AAD existed", async () => {
    if (!available) return
    const legacy = encrypt({ apiKey: "sk-old" }, await getUserKey(db, "u1"))

    expect(await decryptForUser(db, "u1", "user_providers:p1", legacy)).toEqual({
      apiKey: "sk-old",
    })
  })

  it("rotates the system key by re-wrapping user keys; data stays readable", async () => {
    if (!available) return
    const enc = await encryptForUser(db, "u1", "s", { v: 1 })

    internals.systemSecrets.set("encryption", {
      masterKey: V1,
      keys: { "2": V2 },
      currentVersion: 2,
    })
    expect(await rewrapUserKeys(db)).toBe(1)
    expect(
      (await db.collection("user_encryption_keys").findOne({ userId: "u1" }))?.keyVersion,
    ).toBe(2)

    // Version 1 can now be retired
    internals.systemSecrets.set("encryption", {
      masterKey: V2,
      keys: { "2": V2 },
      currentVersion: 2,
    })
    expect(await decryptForUser(db, "u1", "s", enc, AAD_FORMAT)).toEqual({ v: 1 })
  })
})

describe("AuthManager.merge (MOD-6)", () => {
  it("keeps every field when two merges race", async () => {
    if (!available) return
    const auth = new AuthManager(db)
    await auth.set("u1", "app1", "mca.x", { accessToken: "a0" })

    await Promise.all([
      auth.merge("u1", "app1", "mca.x", { accessToken: "a1" }),
      auth.merge("u1", "app1", "mca.x", { refreshToken: "r1" }),
    ])

    expect(await auth.get("u1", "app1")).toEqual({ accessToken: "a1", refreshToken: "r1" })
  })

  it("writes new credentials in the AAD format", async () => {
    if (!available) return
    await new AuthManager(db).set("u1", "app1", "mca.x", { k: 1 })
    expect(
      (await db.collection("user_credentials").findOne({ appId: "app1" }))?.encryptionFormat,
    ).toBe(AAD_FORMAT)
  })
})
