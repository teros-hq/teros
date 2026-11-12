/**
 * Integration test: PasswordResetService against a real Mongo.
 *
 * Covers what a fake collection can't: the atomic attempt counter, the
 * single-use consume, the per-user "latest code wins" rule, the hourly send
 * window, and the TTL index.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards — never touches real collections. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient, ObjectId } from "mongodb"
import { PasswordResetService } from "../../src/auth/password-reset-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_pwreset_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let service: PasswordResetService

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[password reset test] Mongo unreachable — skipping")
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
  await db.collection("password_resets").deleteMany({})
  service = new PasswordResetService(db)
  await service.ensureIndexes()
})

const identityId = new ObjectId()

function issue(userId = "usr_1", email = "dana@example.com") {
  return service.issue({ userId, identityId, email })
}

/** Any 6-digit code other than the right one. */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000"
}

describe("PasswordResetService", () => {
  it("issues a 6-digit code and stores only hashes", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    expect(code).toMatch(/^\d{6}$/)
    const stored = await db.collection("password_resets").findOne({ userId: "usr_1" })
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
    const result = await service.verify(newer.challengeToken, newer.code)
    expect(result.success).toBe(true)
  })

  it("resend issues a new code and resets attempts", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    // Burn one attempt so we can see it reset.
    expect(await service.verify(challengeToken, wrongCode(code))).toEqual({
      success: false,
      error: "code_invalid",
    })

    // Too soon: the cooldown rejects the resend.
    expect(await service.resend(challengeToken)).toEqual({
      success: false,
      error: "resend_too_soon",
    })

    // Travel past the cooldown.
    await db.collection("password_resets").updateOne(
      {},
      { $set: { lastSentAt: new Date(Date.now() - 61_000) } },
    )

    const resent = await service.resend(challengeToken)
    expect(resent.success).toBe(true)
    if (!resent.success) return
    expect(resent.code).toMatch(/^\d{6}$/)
    expect(resent.code).not.toBe(code)

    // The old code no longer works; the new one does.
    expect(await service.verify(challengeToken, code)).toEqual({
      success: false,
      error: "code_invalid",
    })
    const result = await service.verify(challengeToken, resent.code)
    expect(result.success).toBe(true)
  })

  it("caps resends at 3 per hour (hourly window)", async () => {
    if (!available) return
    const { challengeToken } = await issue()

    // issue() counts as send #1; two resends reach the cap.
    for (let i = 0; i < 2; i++) {
      await db.collection("password_resets").updateOne(
        {},
        { $set: { lastSentAt: new Date(Date.now() - 61_000) } },
      )
      expect((await service.resend(challengeToken)).success).toBe(true)
    }

    await db.collection("password_resets").updateOne(
      {},
      { $set: { lastSentAt: new Date(Date.now() - 61_000) } },
    )
    expect(await service.resend(challengeToken)).toEqual({
      success: false,
      error: "too_many_sends",
    })
  })

  it("resend allowed again once the hourly window passes", async () => {
    if (!available) return
    const { challengeToken } = await issue()

    // Exhaust the window.
    await db.collection("password_resets").updateOne(
      {},
      { $set: { sendCount: 3, lastSentAt: new Date(Date.now() - 61_000) } },
    )
    expect(await service.resend(challengeToken)).toEqual({
      success: false,
      error: "too_many_sends",
    })

    // Move the window start (and lastSentAt) into the past.
    const past = new Date(Date.now() - 61 * 60 * 1000)
    await db.collection("password_resets").updateOne(
      {},
      { $set: { sendWindowStart: past, lastSentAt: past } },
    )
    const result = await service.resend(challengeToken)
    expect(result.success).toBe(true)
  })

  it("expires challenges after the TTL", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    await db.collection("password_resets").updateOne(
      {},
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    )

    expect(await service.verify(challengeToken, code)).toEqual({
      success: false,
      error: "challenge_invalid",
    })
  })

  it("isSendLimited counts challenges created in the last hour", async () => {
    if (!available) return
    const email = "limited@example.com"

    expect(await service.isSendLimited(email)).toBe(false)
    await issue("u1", email)
    expect(await service.isSendLimited(email)).toBe(false)
    await issue("u2", email)
    await issue("u3", email)
    expect(await service.isSendLimited(email)).toBe(true)

    // Challenges older than an hour don't count.
    await db.collection("password_resets").updateMany(
      { email },
      { $set: { lastSentAt: new Date(Date.now() - 61 * 60 * 1000) } },
    )
    expect(await service.isSendLimited(email)).toBe(false)
  })

  it("[PWR-AC-1] check() confirms the right code without consuming the challenge", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()

    const checked = await service.check(challengeToken, code)
    expect(checked.success).toBe(true)
    expect(await db.collection("password_resets").countDocuments({})).toBe(1)

    // The reset itself still works with the same code afterwards.
    expect((await service.verify(challengeToken, code)).success).toBe(true)
  })

  it("[PWR-AC-2] check() counts wrong codes on the counter verify() uses and reports attempts left", async () => {
    if (!available) return
    const { challengeToken, code } = await issue()
    const wrong = wrongCode(code)

    expect(await service.check(challengeToken, wrong)).toEqual({
      success: false,
      error: "code_invalid",
      attemptsLeft: 4,
    })
    expect(await service.check(challengeToken, wrong)).toEqual({
      success: false,
      error: "code_invalid",
      attemptsLeft: 3,
    })
    // verify() shares the counter: attempts 3 and 4.
    expect((await service.verify(challengeToken, wrong)).success).toBe(false)
    expect((await service.verify(challengeToken, wrong)).success).toBe(false)
    // Fifth wrong code: the challenge is dropped.
    expect(await service.check(challengeToken, wrong)).toEqual({
      success: false,
      error: "too_many_attempts",
    })
    expect(await db.collection("password_resets").countDocuments({})).toBe(0)
    expect(await service.check(challengeToken, code)).toEqual({
      success: false,
      error: "challenge_invalid",
    })
  })
})
