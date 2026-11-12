/**
 * Email Verification Service
 *
 * Proves that whoever holds a password account owns its email address.
 * A password login (or registration) for an unverified user does not get a
 * session: it gets a challenge, and a 6-digit code is emailed to the user.
 * The client sends the code back with the challenge token to finish signing in.
 *
 * Challenges live in Mongo (not in memory) so they survive the WebSocket
 * reconnect between "code sent" and "code entered", and work across instances.
 * Only hashes of the challenge token and the code are stored.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto"
import { COLLECTIONS, ensureCollectionIndexes } from "../db"
import type { Collection, Db, ObjectId } from "mongodb"

const CHALLENGE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_ATTEMPTS = 5
const MAX_SENDS = 5
const RESEND_COOLDOWN_MS = 60 * 1000 // 1 minute
const TOKEN_BYTES = 32 // 256 bits

export type EmailVerificationPurpose = "register" | "login"

export interface EmailVerificationChallenge {
  /** sha256 of the challenge token handed to the client */
  tokenHash: string
  userId: string
  identityId: ObjectId
  email: string
  purpose: EmailVerificationPurpose
  /** sha256 of the current 6-digit code */
  codeHash: string
  attempts: number
  sendCount: number
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
  | { success: true; challenge: EmailVerificationChallenge }
  | { success: false; error: "challenge_invalid" | "code_invalid" | "too_many_attempts" }

export type ResendResult =
  | { success: true; code: string; challenge: EmailVerificationChallenge }
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

export class EmailVerificationService {
  private challenges: Collection<EmailVerificationChallenge>

  constructor(db: Db) {
    this.challenges = db.collection<EmailVerificationChallenge>("email_verifications")
  }

  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.challenges, COLLECTIONS.emailVerifications)
  }

  /**
   * Start a challenge for a user. Any earlier challenge of the same user is
   * dropped, so only the most recent code works.
   */
  async issue(params: {
    userId: string
    identityId: ObjectId
    email: string
    purpose: EmailVerificationPurpose
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
      purpose: params.purpose,
      codeHash: hash(code),
      attempts: 0,
      sendCount: 1,
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
      const updated = await this.challenges.findOneAndUpdate(
        { tokenHash },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" },
      )
      if (!updated || updated.attempts >= MAX_ATTEMPTS) {
        await this.challenges.deleteOne({ tokenHash })
        return { success: false, error: "too_many_attempts" }
      }
      return { success: false, error: "code_invalid" }
    }

    // Consume: only the caller that deletes the document wins.
    const consumed = await this.challenges.findOneAndDelete({ tokenHash })
    if (!consumed) {
      return { success: false, error: "challenge_invalid" }
    }
    return { success: true, challenge: consumed }
  }

  /**
   * Replace the code of a live challenge with a new one, resetting attempts
   * and the expiry. Throttled per challenge.
   */
  async resend(challengeToken: string): Promise<ResendResult> {
    const tokenHash = hash(challengeToken)
    const challenge = await this.challenges.findOne({ tokenHash })
    const now = new Date()
    if (!challenge || challenge.expiresAt < now) {
      return { success: false, error: "challenge_invalid" }
    }
    if (challenge.sendCount >= MAX_SENDS) {
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
        },
        $inc: { sendCount: 1 },
      },
      { returnDocument: "after" },
    )
    if (!updated) {
      // A concurrent resend won the race.
      return { success: false, error: "resend_too_soon" }
    }
    return { success: true, code, challenge: updated }
  }
}
