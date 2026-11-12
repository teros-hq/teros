/**
 * Integration test: password lockout counter (MOD-6, TER-450).
 *
 * The failed-attempt counter used to be read, incremented in JS and written
 * back with $set, so parallel wrong guesses overwrote each other and the
 * lockout could be outrun. It is now a single pipeline update in Mongo.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { IdentityService } from "../../src/auth/identity-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_lockout_${Date.now()}`
const EMAIL = "dana@example.com"

let client: MongoClient
let db: Db
let available = false
let service: IdentityService

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[lockout test] Mongo unreachable — skipping")
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
  await db.collection("user_identities").deleteMany({})
  service = new IdentityService(db)
  await service.createPasswordIdentity({ userId: "usr_1", email: EMAIL, password: "right-pass" })
})

const stored = async () => (await db.collection("user_identities").findOne({ providerUserId: EMAIL }))?.data

describe("password lockout", () => {
  it("locks on the 5th wrong password and then refuses even the right one", async () => {
    if (!available) return
    for (let i = 1; i <= 4; i++) {
      const r = await service.verifyPassword(EMAIL, "wrong")
      expect(r.error).toBe("invalid_credentials")
      expect(r.lockedUntil).toBeUndefined()
    }
    const fifth = await service.verifyPassword(EMAIL, "wrong")
    expect(fifth.lockedUntil).toBeInstanceOf(Date)

    const right = await service.verifyPassword(EMAIL, "right-pass")
    expect(right.error).toBe("account_locked")
  })

  it("counts every one of many concurrent wrong guesses", async () => {
    if (!available) return
    await Promise.all(Array.from({ length: 8 }, () => service.verifyPassword(EMAIL, "wrong")))

    const data = await stored()
    expect(data?.failedAttempts).toBe(8)
    expect(data?.lockedUntil).toBeInstanceOf(Date)
  })

  it("starts a fresh window once a lockout has elapsed", async () => {
    if (!available) return
    await db
      .collection("user_identities")
      .updateOne(
        { providerUserId: EMAIL },
        { $set: { "data.failedAttempts": 5, "data.lockedUntil": new Date(Date.now() - 1000) } },
      )

    const r = await service.verifyPassword(EMAIL, "wrong")

    expect(r.error).toBe("invalid_credentials")
    expect(r.lockedUntil).toBeUndefined()
    const data = await stored()
    expect(data?.failedAttempts).toBe(1)
    expect(data?.lockedUntil).toBeNull()
  })

  it("resets the counter on a correct password", async () => {
    if (!available) return
    await service.verifyPassword(EMAIL, "wrong")
    await service.verifyPassword(EMAIL, "wrong")

    expect((await service.verifyPassword(EMAIL, "right-pass")).success).toBe(true)
    expect((await stored())?.failedAttempts).toBe(0)
  })
})
