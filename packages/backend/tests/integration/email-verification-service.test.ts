/**
 * Integration test: EmailVerificationService against a real Mongo.
 *
 * Covers what a fake collection can't: the atomic attempt counter, the
 * single-use consume, the per-user "latest code wins" rule and the TTL index.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards — never touches real collections. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient, ObjectId } from "mongodb"
import { EmailVerificationService } from "../../src/auth/email-verification-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_emailverif_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let service: EmailVerificationService

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[email verification test] Mongo unreachable — skipping")
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
  await db.collection("email_verifications").deleteMany({})
  service = new EmailVerificationService(db)
  await service.ensureIndexes()
})

const identityId = new ObjectId()

function issue(userId = "usr_1") {
  return service.issue({ userId, identityId, email: "dana@example.com", purpose: "login" })
}

/** Any 6-digit code other than the right one. */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000"
}

describe("EmailVerificationService", () => {
  it("issues a 6-digit code and stores only hashes", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    expect(code).toMatch(/^\d{6}$/)
    const stored = await db.collection("email_verifications").findOne({ userId: "usr_1" })
    expect(JSON.stringify(stored)).not.toContain(code)
    expect(JSON.stringify(stored)).not.toContain(challengeToken)
  })

  it("accepts the right code once", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    const first = await service.verify(challengeToken, code)
    expect(first.success).toBe(true)
    if (first.success) {
      expect(first.challenge.userId).toBe("usr_1")
      expect(first.challenge.identityId.equals(identityId)).toBe(true)
    }

    const replay = await service.verify(challengeToken, code)
    expect(replay).toEqual({ success: false, error: "challenge_invalid" })
  })

  it("drops the challenge after 5 wrong codes", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    for (let i = 0; i < 4; i++) {
      expect(await service.verify(challengeToken, wrongCode(code))).toEqual({
        success: false,
        error: "code_invalid",
      })
    }
    expect(await service.verify(challengeToken, wrongCode(code))).toEqual({
      success: false,
      error: "too_many_attempts",
    })
    // Even the right code is useless now.
    expect(await service.verify(challengeToken, code)).toEqual({
      success: false,
      error: "challenge_invalid",
    })
  })

  it("counts concurrent wrong guesses without losing any", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.verify(challengeToken, wrongCode(code))),
    )
    expect(results.filter((r) => !r.success && r.error === "code_invalid")).toHaveLength(4)
    expect(await service.verify(challengeToken, code)).toEqual({
      success: false,
      error: "challenge_invalid",
    })
  })

  it("keeps only the latest challenge per user", async () => {
    if (!available) return
    const older = await issue()
    const newer = await issue()

    expect(await service.verify(older.challengeToken, older.code)).toEqual({
      success: false,
      error: "challenge_invalid",
    })
    expect((await service.verify(newer.challengeToken, newer.code)).success).toBe(true)
  })

  it("rejects an expired challenge", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()
    await db
      .collection("email_verifications")
      .updateOne({ userId: "usr_1" }, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    expect(await service.verify(challengeToken, code)).toEqual({
      success: false,
      error: "challenge_invalid",
    })
  })

  it("throttles resends and replaces the code", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    expect(await service.resend(challengeToken)).toEqual({
      success: false,
      error: "resend_too_soon",
    })

    await db
      .collection("email_verifications")
      .updateOne({ userId: "usr_1" }, { $set: { lastSentAt: new Date(Date.now() - 61_000) } })
    const resent = await service.resend(challengeToken)
    expect(resent.success).toBe(true)
    if (!resent.success) return

    if (resent.code !== code) {
      expect(await service.verify(challengeToken, code)).toEqual({
        success: false,
        error: "code_invalid",
      })
    }
    expect((await service.verify(challengeToken, resent.code)).success).toBe(true)
  })

  it("caps the number of codes sent per challenge", async () => {
    if (!available) return
    const { challengeToken } = await issue()
    await db
      .collection("email_verifications")
      .updateOne({ userId: "usr_1" }, { $set: { sendCount: 5 } })

    expect(await service.resend(challengeToken)).toEqual({
      success: false,
      error: "too_many_sends",
    })
  })

  it("creates the TTL index on expiresAt", async () => {
    if (!available) return
    const indexes = await db.collection("email_verifications").indexes()
    const ttl = indexes.find((i) => i.key.expiresAt === 1)
    expect(ttl?.expireAfterSeconds).toBe(0)
  })
})
