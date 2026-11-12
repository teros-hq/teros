/**
 * AuthService's password reset flow.
 *
 * Covered here with every collaborator stubbed:
 *
 *   1. requestPasswordReset: known email → code emailed + hashed reset token
 *      stored on the identity; unknown email → decoy challenge ('unknown'),
 *      no email, IDENTICAL response shape (anti-enumeration); rate-limited
 *      email → same shape with a non-functional token.
 *   2. completePasswordReset: verifies the code, rejects decoys, sets the new
 *      password, clears the reset token, revokes all sessions + API tokens,
 *      and signs the user in with a fresh session. Weak passwords rejected
 *      before touching the challenge.
 *   3. resendPasswordReset: sends a fresh code for real challenges, sends
 *      nothing for decoys, reports throttling.
 *
 * The PasswordResetService itself (hashing, attempts, TTL, rate windows) is
 * covered against real Mongo in tests/integration/password-reset-service.test.ts.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"

const sendPasswordReset = mock(() => Promise.resolve({ success: true }))
let configured = true

afterAll(() => {
  // bun mock.module leaks into every later file of the run and mock.restore()
  // does not undo it: leave the leaked module answering "email not configured"
  // so no later suite (dev-seed → user-service.grantAccess) walks into this stub.
  configured = false
})

import * as emailModule from "../../src/services/email-service"

mock.module("../../src/services/email-service", () => ({
  ...emailModule,
  isEmailConfigured: () => configured,
  getEmailService: () => ({
    sendPasswordReset,
    // bun mock.module leaks into every later file of the run: user-service
    // grantAccess (dev-seed.test) calls sendAccessGranted on this stub.
    sendAccessGranted: mock(() => Promise.resolve({ success: true })),
  }),
}))

// API-token revocation goes through the real api-tokens module against this
// collection stub. (A mock.module of api-tokens would leak into every later
// test file in the same bun run — see auth-service-password-change.test.ts.)
const deleteApiTokens = mock(() => Promise.resolve({ deletedCount: 2 }))

import { AuthService } from "../../src/auth/auth-service"

/** Let fire-and-forget promises (void sendPasswordResetCode) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const baseUser = {
  userId: "usr_1",
  status: "active",
  emailVerified: true,
  accessGranted: true,
  profile: { email: "dana@example.com", displayName: "Dana" },
}

const baseIdentity = { _id: "idn_1", userId: "usr_1", type: "password" }

function makeAuthService(opts: {
  identity?: unknown
  user?: unknown
  sendLimited?: boolean
} = {}) {
  const identity = opts.identity === undefined ? baseIdentity : opts.identity
  const user = opts.user === undefined ? baseUser : opts.user

  const db = {
    collection: (name: string) =>
      name === "api_tokens" ? { deleteMany: deleteApiTokens } : {},
  }
  const auth = new AuthService(db as never)
  const stubs = {
    userService: {
      getByUserId: mock(() => Promise.resolve(user)),
      updateLastLogin: mock(() => Promise.resolve()),
    },
    identityService: {
      getByProvider: mock(() => Promise.resolve(identity)),
      changePassword: mock(() => Promise.resolve(true)),
      setPasswordResetToken: mock(() => Promise.resolve()),
      clearPasswordResetToken: mock(() => Promise.resolve()),
    },
    sessionService: {
      createSession: mock(() => Promise.resolve({ token: "tok_new" })),
      revokeAllUserSessions: mock(() => Promise.resolve(3)),
    },
    passwordResetService: {
      isSendLimited: mock(() => Promise.resolve(opts.sendLimited ?? false)),
      issue: mock((params: { userId: string }) =>
        Promise.resolve({ challengeToken: "chl_1", code: "424242" }),
      ),
      verify: mock(() =>
        Promise.resolve({
          success: true,
          challenge: {
            userId: "usr_1",
            identityId: "idn_1",
            email: "dana@example.com",
            userAgent: "ua",
            ipAddress: "1.2.3.4",
          },
        }),
      ),
      resend: mock(() =>
        Promise.resolve({
          success: true,
          code: "777777",
          challenge: { userId: "usr_1", email: "dana@example.com" },
        }),
      ),
    },
  }
  Object.assign(auth, stubs)
  return { auth, stubs }
}

describe("AuthService password reset", () => {
  beforeEach(() => {
    sendPasswordReset.mockClear()
    deleteApiTokens.mockClear()
    configured = true
  })

  describe("requestPasswordReset", () => {
    it("emails the code and stores the hashed reset token for a registered email", async () => {
      const { auth, stubs } = makeAuthService()
      const result = await auth.requestPasswordReset("dana@example.com")
      await flush() // the reset email is fire-and-forget

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe("password_reset_required")
      expect(result.passwordReset).toEqual({ challengeToken: "chl_1", email: "dana@example.com" })

      // Real challenge issued with the real userId
      expect(stubs.passwordResetService.issue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "usr_1", email: "dana@example.com" }),
      )
      // Hashed reset token stored on the identity (PasswordIdentityData.resetToken)
      expect(stubs.identityService.setPasswordResetToken).toHaveBeenCalledWith(
        "idn_1",
        expect.stringMatching(/^[0-9a-f]{64}$/), // sha256 hex
        expect.any(Date),
      )
      expect(sendPasswordReset).toHaveBeenCalledWith("dana@example.com", {
        USER_NAME: "Dana",
        CODE: "424242",
      })
    })

    it("answers identically for an unknown email, issuing a decoy and sending nothing", async () => {
      const { auth, stubs } = makeAuthService({ identity: null })
      const result = await auth.requestPasswordReset("ghost@example.com")

      // Same shape as the known-email case — no enumeration.
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe("password_reset_required")
      expect(result.passwordReset?.challengeToken).toBe("chl_1")
      expect(result.passwordReset?.email).toBe("ghost@example.com")

      // Decoy challenge: userId 'unknown', never deliverable
      expect(stubs.passwordResetService.issue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "unknown", email: "ghost@example.com" }),
      )
      await flush()
      expect(sendPasswordReset).not.toHaveBeenCalled()
      expect(stubs.identityService.setPasswordResetToken).not.toHaveBeenCalled()
    })

    it("answers identically when rate-limited, with a non-functional token", async () => {
      const { auth, stubs } = makeAuthService({ sendLimited: true })
      const result = await auth.requestPasswordReset("dana@example.com")

      expect(result.errorCode).toBe("password_reset_required")
      expect(result.passwordReset?.challengeToken).toBe("limited")
      // No challenge issued, no email sent, no token stored
      await flush()
      expect(stubs.passwordResetService.issue).not.toHaveBeenCalled()
      expect(sendPasswordReset).not.toHaveBeenCalled()
    })

    it("normalizes the email (lowercase + trim)", async () => {
      const { auth, stubs } = makeAuthService()
      await auth.requestPasswordReset("  Dana@Example.COM  ")

      expect(stubs.passwordResetService.isSendLimited).toHaveBeenCalledWith("dana@example.com")
      expect(stubs.identityService.getByProvider).toHaveBeenCalledWith("password", "dana@example.com")
    })
  })

  describe("completePasswordReset", () => {
    it("rejects a weak password before verifying the code", async () => {
      const { auth, stubs } = makeAuthService()
      const result = await auth.completePasswordReset("chl_1", "424242", "short")

      expect(result).toEqual({
        success: false,
        error: "Password must be at least 8 characters",
        errorCode: "password_too_weak",
      })
      expect(stubs.passwordResetService.verify).not.toHaveBeenCalled()
    })

    it("maps service errors to user-facing messages", async () => {
      const { auth, stubs } = makeAuthService()
      stubs.passwordResetService.verify.mockResolvedValueOnce({
        success: false,
        error: "code_invalid",
      })

      const result = await auth.completePasswordReset("chl_1", "000000", "long-enough-password")
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe("password_reset_invalid")
      expect(result.error).toBe("Incorrect reset code")
    })

    it("rejects decoy challenges even when the code verifies", async () => {
      const { auth, stubs } = makeAuthService()
      stubs.passwordResetService.verify.mockResolvedValueOnce({
        success: true,
        challenge: { userId: "unknown", identityId: "idn_x", email: "ghost@example.com" },
      })

      const result = await auth.completePasswordReset("chl_1", "424242", "brand-new-password")
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe("password_reset_invalid")
      // Nothing was touched
      expect(stubs.identityService.changePassword).not.toHaveBeenCalled()
      expect(stubs.sessionService.revokeAllUserSessions).not.toHaveBeenCalled()
    })

    it("sets the password, clears reset state, revokes everything, and signs in", async () => {
      const { auth, stubs } = makeAuthService()
      const result = await auth.completePasswordReset("chl_1", "424242", "brand-new-password")

      expect(stubs.identityService.changePassword).toHaveBeenCalledWith("usr_1", "brand-new-password")
      expect(stubs.identityService.clearPasswordResetToken).toHaveBeenCalledWith("idn_1")
      expect(stubs.sessionService.revokeAllUserSessions).toHaveBeenCalledWith("usr_1", "security")
      expect(deleteApiTokens).toHaveBeenCalledWith({ userId: "usr_1" })
      expect(stubs.sessionService.createSession).toHaveBeenCalled()
      expect(stubs.userService.updateLastLogin).toHaveBeenCalledWith("usr_1")

      expect(result.success).toBe(true)
      expect(result.session?.token).toBe("tok_new")
      expect(result.user?.userId).toBe("usr_1")
    })

    it("refuses a suspended user even with a valid code", async () => {
      const { auth, stubs } = makeAuthService({ user: { ...baseUser, status: "suspended" } })
      const result = await auth.completePasswordReset("chl_1", "424242", "brand-new-password")

      expect(result).toEqual({
        success: false,
        error: "Account suspended",
        errorCode: "account_suspended",
      })
      expect(stubs.identityService.changePassword).not.toHaveBeenCalled()
    })
  })

  describe("resendPasswordReset", () => {
    it("emails a fresh code for a real challenge", async () => {
      const { auth } = makeAuthService()
      const result = await auth.resendPasswordReset("chl_1")
      await flush() // the reset email is fire-and-forget

      expect(result.errorCode).toBe("password_reset_required")
      expect(sendPasswordReset).toHaveBeenCalledWith("dana@example.com", {
        USER_NAME: "Dana",
        CODE: "777777",
      })
    })

    it("sends nothing for a decoy challenge (userId 'unknown')", async () => {
      const { auth, stubs } = makeAuthService()
      stubs.passwordResetService.resend.mockResolvedValueOnce({
        success: true,
        code: "777777",
        challenge: { userId: "unknown", email: "ghost@example.com" },
      })

      const result = await auth.resendPasswordReset("chl_1")
      await flush()
      expect(result.errorCode).toBe("password_reset_required")
      expect(sendPasswordReset).not.toHaveBeenCalled()
    })

    it("reports throttling", async () => {
      const { auth, stubs } = makeAuthService()
      stubs.passwordResetService.resend.mockResolvedValueOnce({
        success: false,
        error: "too_many_sends",
      })

      const result = await auth.resendPasswordReset("chl_1")
      expect(result.errorCode).toBe("password_reset_resend_limited")
    })
  })

  describe("verifyPasswordResetCode", () => {
    const realChallenge = { userId: "usr_1", email: "dana@example.com" }

    it("[PWR-AC-3] answers password_reset_code_valid with codeVerified for the right code", async () => {
      const { auth, stubs } = makeAuthService()
      const check = mock(() => Promise.resolve({ success: true, challenge: realChallenge }))
      Object.assign(stubs.passwordResetService, { check })

      const result = await auth.verifyPasswordResetCode("chl_1", "424242")

      expect(check).toHaveBeenCalledWith("chl_1", "424242")
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe("password_reset_code_valid")
      expect(result.passwordReset).toEqual({
        challengeToken: "chl_1",
        email: "dana@example.com",
        codeVerified: true,
      })
    })

    it("[PWR-AC-3] tells how many attempts are left after a wrong code", async () => {
      const { auth, stubs } = makeAuthService()
      Object.assign(stubs.passwordResetService, {
        check: mock(() => Promise.resolve({ success: false, error: "code_invalid", attemptsLeft: 4 })),
      })

      const result = await auth.verifyPasswordResetCode("chl_1", "000000")

      expect(result.errorCode).toBe("password_reset_invalid")
      expect(result.error).toBe("Incorrect code. 4 attempts left.")
      expect(result.passwordReset).toBeUndefined()
    })

    it("[PWR-AC-3] says to request a new code when attempts run out or the challenge expired", async () => {
      const { auth, stubs } = makeAuthService()
      Object.assign(stubs.passwordResetService, {
        check: mock(() => Promise.resolve({ success: false, error: "too_many_attempts" })),
      })
      expect((await auth.verifyPasswordResetCode("chl_1", "000000")).error).toBe(
        "Too many incorrect codes. Request a new one.",
      )

      Object.assign(stubs.passwordResetService, {
        check: mock(() => Promise.resolve({ success: false, error: "challenge_invalid" })),
      })
      expect((await auth.verifyPasswordResetCode("chl_1", "000000")).error).toBe(
        "Reset code expired. Request a new one.",
      )
    })

    it("[PWR-AC-4] a decoy challenge fails as a wrong code even with its own code", async () => {
      const { auth, stubs } = makeAuthService()
      const check = mock((_token: string, code: string) =>
        Promise.resolve(
          code === "424242"
            ? { success: true, challenge: { userId: "unknown", email: "ghost@example.com" } }
            : { success: false, error: "code_invalid", attemptsLeft: 4 },
        ),
      )
      Object.assign(stubs.passwordResetService, { check })

      const result = await auth.verifyPasswordResetCode("chl_decoy", "424242")

      expect(result.errorCode).toBe("password_reset_invalid")
      expect(result.error).toBe("Incorrect code. 4 attempts left.")
      expect(result.passwordReset).toBeUndefined()
      expect(check).toHaveBeenCalledTimes(2) // the second call counts the attempt
    })
  })
})
