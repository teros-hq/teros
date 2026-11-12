/**
 * Password Reset Service
 *
 * Lets a user who forgot their password prove ownership of their email
 * and set a new one. A 6-digit code is emailed to the user; the client
 * sends the code back with the challenge token and the new password.
 *
 * Challenges live in Mongo (not in memory) so they survive the WebSocket
 * reconnect between "code sent" and "code entered", and work across instances.
 * Only hashes of the challenge token and the code are stored.
 *
 * Security properties:
 * - forgot_password always returns the same shape whether the email exists
 *   or not (no account enumeration).
 * - Reset token is stored hashed (sha256), never in plaintext.
 * - Code expires after 15 minutes and is invalidated on use.
 * - Rate limited: max 3 codes per hour per email, max 5 attempts per challenge.
 * - All sessions are revoked when the reset completes.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto"
import { COLLECTIONS, ensureCollectionIndexes } from "../db"
import type { Collection, Db, ObjectId } from "mongodb"

const CHALLENGE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_ATTEMPTS = 5
const MAX_SENDS_PER_HOUR = 3
const RESEND_COOLDOWN_MS = 60 * 1000 // 1 minute
const TOKEN_BYTES = 32 // 256 bits

export interface PasswordResetChallenge {
  /** sha256 of the challenge token handed to the client */
  tokenHash: string
  userId: string
  identityId: ObjectId
  email: string
  /** sha256 of the current 6-digit code */
  codeHash: string
  attempts: number
  sendCount: number
  /** Window start for the hourly send limit */
  sendWindowStart: Date
  lastSentAt: Date
  expiresAt: Date
  createdAt: Date
  userAgent?: string
  ipAddress?: string
}

export interface IssuedChallenge {
  challengeToken: string
  code: string
}

export type VerifyResult =
  | { success: true; challenge: PasswordResetChallenge }
  | { success: false; error: "challenge_invalid" | "code_invalid" | "too_many_attempts" }

export type CheckResult =
  | { success: true; challenge: PasswordResetChallenge }
  | { success: false; error: "challenge_invalid" | "too_many_attempts" }
  | { success: false; error: "code_invalid"; attemptsLeft: number }

export type ResendResult =
  | { success: true; code: string; challenge: PasswordResetChallenge }
  | { success: false; error: "challenge_invalid" | "resend_too_soon" | "too_many_sends" }

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0")
}

function sameHash(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex")
  const bufB = Buffer.from(b, "hex")
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

export class PasswordResetService {
  private challenges: Collection<PasswordResetChallenge>

  constructor(db: Db) {
    this.challenges = db.collection<PasswordResetChallenge>("password_resets")
  }

  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.challenges, COLLECTIONS.passwordResets)
  }

  /**
   * Start a challenge for a user. Any earlier challenge of the same user is
   * dropped, so only the most recent code works.
   */
  async issue(params: {
    userId: string
    identityId: ObjectId
    email: string
    userAgent?: string
    ipAddress?: string
  }): Promise<IssuedChallenge> {
    const challengeToken = randomBytes(TOKEN_BYTES).toString("base64url")
    const code = generateCode()
    const now = new Date()

    await this.challenges.deleteMany({ userId: params.userId })
    await this.challenges.insertOne({
      tokenHash: hash(challengeToken),
      userId: params.userId,
      identityId: params.identityId,
      email: params.email,
      codeHash: hash(code),
      attempts: 0,
      sendCount: 1,
      sendWindowStart: now,
      lastSentAt: now,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      createdAt: now,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    })

    return { challengeToken, code }
  }

  /**
   * Check a code. A correct code consumes the challenge; a wrong one counts
   * as an attempt, and the challenge is dropped after MAX_ATTEMPTS.
   */
  async verify(challengeToken: string, code: string): Promise<VerifyResult> {
    const tokenHash = hash(challengeToken)
    const challenge = await this.challenges.findOne({ tokenHash })
    if (!challenge || challenge.expiresAt < new Date()) {
      return { success: false, error: "challenge_invalid" }
    }

    if (!sameHash(hash(code.trim()), challenge.codeHash)) {
      // Count the attempt atomically; concurrent guesses can't share a slot.
      const counted = await this.countWrongCode(tokenHash)
      return { success: false, error: counted.error }
    }

    // Consume: only the caller that deletes the document wins.
    const consumed = await this.challenges.findOneAndDelete({ tokenHash })
    if (!consumed) {
      return { success: false, error: "challenge_invalid" }
    }
    return { success: true, challenge: consumed }
  }

  /**
   * Check a code without consuming the challenge, so the client can confirm it
   * before asking for the new password. A wrong code counts against the same
   * attempt limit as verify().
   * @spec PWR-REQ-2 PWR-REQ-3
   */
  async check(challengeToken: string, code: string): Promise<CheckResult> {
    const tokenHash = hash(challengeToken)
    const challenge = await this.challenges.findOne({ tokenHash })
    if (!challenge || challenge.expiresAt < new Date()) {
      return { success: false, error: "challenge_invalid" }
    }

    if (!sameHash(hash(code.trim()), challenge.codeHash)) {
      return this.countWrongCode(tokenHash)
    }
    return { success: true, challenge }
  }

  /** Count one wrong code atomically; the challenge is dropped at MAX_ATTEMPTS. */
  private async countWrongCode(
    tokenHash: string,
  ): Promise<
    | { success: false; error: "too_many_attempts" }
    | { success: false; error: "code_invalid"; attemptsLeft: number }
  > {
    const updated = await this.challenges.findOneAndUpdate(
      { tokenHash },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" },
    )
    if (!updated || updated.attempts >= MAX_ATTEMPTS) {
      await this.challenges.deleteOne({ tokenHash })
      return { success: false, error: "too_many_attempts" }
    }
    return { success: false, error: "code_invalid", attemptsLeft: MAX_ATTEMPTS - updated.attempts }
  }

  /**
   * Replace the code of a live challenge with a new one, resetting attempts
   * and the expiry. Throttled per challenge and per email (hourly window).
   */
  async resend(challengeToken: string): Promise<ResendResult> {
    const tokenHash = hash(challengeToken)
    const challenge = await this.challenges.findOne({ tokenHash })
    const now = new Date()
    if (!challenge || challenge.expiresAt < now) {
      return { success: false, error: "challenge_invalid" }
    }

    // Hourly rate limit: reset the window if it has passed
    const windowElapsed = now.getTime() - challenge.sendWindowStart.getTime() > 60 * 60 * 1000
    const effectiveSendCount = windowElapsed ? 0 : challenge.sendCount
    if (effectiveSendCount >= MAX_SENDS_PER_HOUR) {
      return { success: false, error: "too_many_sends" }
    }

    if (now.getTime() - challenge.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      return { success: false, error: "resend_too_soon" }
    }

    const code = generateCode()
    const updated = await this.challenges.findOneAndUpdate(
      { tokenHash, sendCount: challenge.sendCount },
      {
        $set: {
          codeHash: hash(code),
          attempts: 0,
          lastSentAt: now,
          expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
          ...(windowElapsed ? { sendWindowStart: now, sendCount: 1 } : {}),
        },
        ...(windowElapsed ? {} : { $inc: { sendCount: 1 } }),
      },
      { returnDocument: "after" },
    )
    if (!updated) {
      // A concurrent resend won the race.
      return { success: false, error: "resend_too_soon" }
    }
    return { success: true, code, challenge: updated }
  }

  /**
   * Check whether an email has exceeded the hourly send limit.
   * Used by forgot_password to throttle requests for the same address.
   */
  async isSendLimited(email: string): Promise<boolean> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const count = await this.challenges.countDocuments({
      email: email.toLowerCase(),
      lastSentAt: { $gte: oneHourAgo },
    })
    return count >= MAX_SENDS_PER_HOUR
  }
}
