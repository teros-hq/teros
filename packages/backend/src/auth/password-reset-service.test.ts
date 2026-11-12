/**
 * Password Reset Service Tests
 *
 * Covers the security-critical paths of the 6-digit code reset flow:
 * - issue() creates a challenge with hashed token+code
 * - verify() consumes a correct code, rejects wrong ones, enforces attempt limit
 * - resend() throttles by cooldown and hourly send limit
 * - isSendLimited() enforces the per-email hourly cap
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { MongoClient, type Db } from "mongodb"
import { PasswordResetService } from "./password-reset-service"

const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017"
const DB_NAME = "teros-test-password-reset"

describe("PasswordResetService", () => {
  let client: MongoClient
  let db: Db
  let service: PasswordResetService

  beforeEach(async () => {
    client = new MongoClient(MONGO_URL)
    await client.connect()
    db = client.db(DB_NAME)
    service = new PasswordResetService(db)
    await service.ensureIndexes()
  })

  afterEach(async () => {
    await db.dropDatabase()
    await client.close()
  })

  describe("issue", () => {
    it("creates a challenge with hashed token and code", async () => {
      const { challengeToken, code } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      expect(challengeToken).toBeString()
      expect(challengeToken.length).toBeGreaterThan(20)
      expect(code).toMatch(/^\d{6}$/)

      // Only hashes are stored
      const stored = await db.collection("password_resets").findOne({ userId: "user-1" })
      expect(stored).toBeTruthy()
      expect(stored!.tokenHash).not.toBe(challengeToken)
      expect(stored!.codeHash).not.toBe(code)
      expect(stored!.tokenHash).toMatch(/^[a-f0-9]{64}$/)
      expect(stored!.codeHash).toMatch(/^[a-f0-9]{64}$/)
    })

    it("replaces any existing challenge for the same user", async () => {
      const first = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })
      const second = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      const count = await db.collection("password_resets").countDocuments({ userId: "user-1" })
      expect(count).toBe(1)

      // Old token no longer works
      const result = await service.verify(first.challengeToken, first.code)
      expect(result.success).toBe(false)
    })
  })

  describe("verify", () => {
    it("consumes a correct code", async () => {
      const { challengeToken, code } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      const result = await service.verify(challengeToken, code)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.challenge.userId).toBe("user-1")
        expect(result.challenge.email).toBe("test@example.com")
      }

      // Challenge is consumed — can't verify again
      const again = await service.verify(challengeToken, code)
      expect(again.success).toBe(false)
    })

    it("rejects a wrong code and counts attempts", async () => {
      const { challengeToken } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      const result = await service.verify(challengeToken, "000000")
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe("code_invalid")
      }
    })

    it("drops the challenge after too many attempts", async () => {
      const { challengeToken } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      // The 5th wrong attempt hits MAX_ATTEMPTS and drops the challenge
      let last: Awaited<ReturnType<typeof service.verify>> | undefined
      for (let i = 0; i < 5; i++) {
        last = await service.verify(challengeToken, "000000")
      }
      expect(last!.success).toBe(false)
      if (!last!.success) {
        expect(last!.error).toBe("too_many_attempts")
      }

      // After the drop the challenge is gone for good
      const result = await service.verify(challengeToken, "000000")
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe("challenge_invalid")
      }
    })

    it("rejects an expired challenge", async () => {
      const { challengeToken, code } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      // Force expiry
      await db.collection("password_resets").updateOne(
        { userId: "user-1" },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      )

      const result = await service.verify(challengeToken, code)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe("challenge_invalid")
      }
    })
  })

  describe("resend", () => {
    it("issues a new code and resets attempts", async () => {
      const { challengeToken, code: oldCode } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      // Burn one attempt
      await service.verify(challengeToken, "000000")

      // issue() just set lastSentAt — travel past the 60s cooldown
      await db.collection("password_resets").updateOne(
        {},
        { $set: { lastSentAt: new Date(Date.now() - 61_000) } },
      )

      const result = await service.resend(challengeToken)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.code).not.toBe(oldCode)
        expect(result.challenge.attempts).toBe(0)
        expect(result.challenge.sendCount).toBe(2)
      }
    })

    it("enforces the resend cooldown", async () => {
      const { challengeToken } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      const result = await service.resend(challengeToken)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe("resend_too_soon")
      }
    })

    it("enforces the hourly send limit", async () => {
      const { challengeToken } = await service.issue({
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
      })

      // Fast-forward past cooldown
      await db.collection("password_resets").updateOne(
        { userId: "user-1" },
        { $set: { lastSentAt: new Date(Date.now() - 120_000) } },
      )

      // Send up to the limit (3 total: initial + 2 resends)
      await service.resend(challengeToken)
      await db.collection("password_resets").updateOne(
        { userId: "user-1" },
        { $set: { lastSentAt: new Date(Date.now() - 120_000) } },
      )
      await service.resend(challengeToken)

      // Fourth send should be blocked
      await db.collection("password_resets").updateOne(
        { userId: "user-1" },
        { $set: { lastSentAt: new Date(Date.now() - 120_000) } },
      )
      const result = await service.resend(challengeToken)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe("too_many_sends")
      }
    })
  })

  describe("isSendLimited", () => {
    it("returns false when under the limit", async () => {
      const limited = await service.isSendLimited("test@example.com")
      expect(limited).toBe(false)
    })

    it("returns true when at the limit", async () => {
      const now = new Date()
      // Insert 3 recent challenges for the same email
      for (let i = 0; i < 3; i++) {
        await db.collection("password_resets").insertOne({
          tokenHash: `hash-${i}`,
          userId: "user-1",
          identityId: new (await import("mongodb")).ObjectId(),
          email: "test@example.com",
          codeHash: "codehash",
          attempts: 0,
          sendCount: 1,
          sendWindowStart: now,
          lastSentAt: now,
          expiresAt: new Date(now.getTime() + 900_000),
          createdAt: now,
        })
      }

      const limited = await service.isSendLimited("test@example.com")
      expect(limited).toBe(true)
    })

    it("ignores challenges older than one hour", async () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await db.collection("password_resets").insertOne({
        tokenHash: "old-hash",
        userId: "user-1",
        identityId: new (await import("mongodb")).ObjectId(),
        email: "test@example.com",
        codeHash: "codehash",
        attempts: 0,
        sendCount: 1,
        sendWindowStart: old,
        lastSentAt: old,
        expiresAt: new Date(old.getTime() + 900_000),
        createdAt: old,
      })

      const limited = await service.isSendLimited("test@example.com")
      expect(limited).toBe(false)
    })
  })
})
