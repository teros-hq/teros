/**
 * AuthService's email verification gate (SEC-1, part 1).
 *
 * A password account gets no session until it proves it owns its email with
 * the 6-digit code. Covered here with every collaborator stubbed:
 *
 *   1. loginWithPassword: unverified → challenge + code emailed, no session;
 *      verified → session as before.
 *   2. completeEmailVerification: marks the email verified, then MFA or session;
 *      a wrong code changes nothing.
 *   3. resendEmailVerification: sends a fresh code, reports throttling.
 *   4. Without email configured, the code is logged in dev and never in prod.
 *
 * The EmailVerificationService itself (hashing, attempts, TTL) is covered
 * against real Mongo in tests/integration/email-verification-service.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

const sendEmailVerification = mock(() => Promise.resolve({ success: true }))
const sendWelcome = mock(() => Promise.resolve({ success: true }))
let configured = true

import * as emailModule from "../../src/services/email-service"

mock.module("../../src/services/email-service", () => ({
  ...emailModule,
  isEmailConfigured: () => configured,
  getEmailService: () => ({
    sendEmailVerification,
    sendWelcome,
    sendWelcomeRegistered: sendWelcome,
    // bun mock.module leaks into every later file of the run: user-service
    // grantAccess (dev-seed.test) calls sendAccessGranted on this stub.
    sendAccessGranted: mock(() => Promise.resolve({ success: true })),
  }),
}))

import { AuthService } from "../../src/auth/auth-service"

const baseUser = {
  userId: "usr_1",
  status: "active",
  emailVerified: false,
  accessGranted: true,
  profile: { email: "dana@example.com", displayName: "Dana" },
}

function makeAuthService(user: Record<string, unknown> = baseUser) {
  const auth = new AuthService({ collection: () => ({}) } as never)
  const stubs = {
    userService: {
      getByUserId: mock(() => Promise.resolve(user)),
      markEmailVerified: mock(() => Promise.resolve()),
      activatePendingMemberships: mock(() => Promise.resolve()),
      updateLastLogin: mock(() => Promise.resolve()),
    },
    identityService: {
      verifyPassword: mock(() =>
        Promise.resolve({ success: true, identity: { _id: "idn_1", userId: "usr_1" } }),
      ),
    },
    sessionService: {
      createSession: mock(() => Promise.resolve({ token: "tok_1" })),
    },
    emailVerificationService: {
      issue: mock(() => Promise.resolve({ challengeToken: "chl_1", code: "424242" })),
      verify: mock(() =>
        Promise.resolve({
          success: true,
          challenge: { userId: "usr_1", identityId: "idn_1", purpose: "login", email: "dana@example.com" },
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

/** sendVerificationCode is void-ed by its callers; let its microtasks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const login = (auth: AuthService) =>
  auth.loginWithPassword({ email: "Dana@Example.com", password: "pw", ipAddress: "1.2.3.4" })

const originalNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  configured = true
  for (const m of [sendEmailVerification, sendWelcome]) {
    m.mockReset()
    m.mockImplementation(() => Promise.resolve({ success: true }))
  }
})

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
})

afterAll(() => {
  // bun mock.module leaks into every later file of the run and mock.restore()
  // does not undo it: leave the leaked module answering "email not configured"
  // so no later suite (dev-seed → user-service.grantAccess) walks into this stub.
  configured = false
  mock.restore()
})

describe("loginWithPassword", () => {
  it("answers an unverified account with a challenge and emails the code", async () => {
    const { auth, stubs } = makeAuthService()

    const result = await login(auth)
    await flush()

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("email_verification_required")
    expect(result.emailVerification).toEqual({ challengeToken: "chl_1", email: "dana@example.com" })
    expect(result.session).toBeUndefined()
    expect(stubs.sessionService.createSession).not.toHaveBeenCalled()
    expect(stubs.emailVerificationService.issue.mock.calls[0]).toEqual([
      expect.objectContaining({ userId: "usr_1", purpose: "login", ipAddress: "1.2.3.4" }),
    ])
    expect(sendEmailVerification.mock.calls[0]).toEqual([
      "dana@example.com",
      { USER_NAME: "Dana", CODE: "424242" },
    ])
  })

  it("signs a verified account straight in", async () => {
    const { auth, stubs } = makeAuthService({ ...baseUser, emailVerified: true })

    const result = await login(auth)
    await flush()

    expect(result.success).toBe(true)
    expect(stubs.sessionService.createSession).toHaveBeenCalledTimes(1)
    expect(stubs.emailVerificationService.issue).not.toHaveBeenCalled()
    expect(sendEmailVerification).not.toHaveBeenCalled()
  })

  it("checks suspension before sending any code", async () => {
    const { auth, stubs } = makeAuthService({ ...baseUser, status: "suspended" })

    const result = await login(auth)

    expect(result.errorCode).toBe("account_suspended")
    expect(stubs.emailVerificationService.issue).not.toHaveBeenCalled()
  })
})

describe("completeEmailVerification", () => {
  it("marks the email verified and creates a session", async () => {
    const { auth, stubs } = makeAuthService()

    const result = await auth.completeEmailVerification("chl_1", "424242")

    expect(result.success).toBe(true)
    expect(result.session).toEqual({ token: "tok_1" } as never)
    expect(stubs.userService.markEmailVerified.mock.calls[0]).toEqual(["usr_1"])
    // MUW-14 Fase 2: verifying the email no longer activates pending
    // invitations — they stay pending until the user accepts them in the app
    // (workspace.accept_invitation).
    expect(stubs.userService.activatePendingMemberships).not.toHaveBeenCalled()
    // A login (not a registration) sends no welcome email.
    await flush()
    expect(sendWelcome).not.toHaveBeenCalled()
  })

  it("continues to the MFA challenge when MFA is enabled", async () => {
    const { auth, stubs } = makeAuthService({ ...baseUser, mfa: { enabled: true } })

    const result = await auth.completeEmailVerification("chl_1", "424242")

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("mfa_required")
    expect(result.mfaChallenge?.challengeToken).toBeString()
    expect(stubs.sessionService.createSession).not.toHaveBeenCalled()
  })

  it("rejects a wrong code without verifying anything", async () => {
    const { auth, stubs } = makeAuthService()
    stubs.emailVerificationService.verify.mockImplementation(
      () => Promise.resolve({ success: false, error: "code_invalid" }) as never,
    )

    const result = await auth.completeEmailVerification("chl_1", "000000")

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("email_verification_invalid")
    expect(result.error).toBe("Incorrect verification code")
    expect(stubs.userService.markEmailVerified).not.toHaveBeenCalled()
    expect(stubs.sessionService.createSession).not.toHaveBeenCalled()
  })
})

describe("resendEmailVerification", () => {
  it("emails a fresh code and keeps the same challenge", async () => {
    const { auth } = makeAuthService()

    const result = await auth.resendEmailVerification("chl_1")
    await flush()

    expect(result.errorCode).toBe("email_verification_required")
    expect(result.emailVerification).toEqual({ challengeToken: "chl_1", email: "dana@example.com" })
    expect(sendEmailVerification.mock.calls[0]).toEqual([
      "dana@example.com",
      { USER_NAME: "Dana", CODE: "777777" },
    ])
  })

  it("reports throttling without sending", async () => {
    const { auth, stubs } = makeAuthService()
    stubs.emailVerificationService.resend.mockImplementation(
      () => Promise.resolve({ success: false, error: "resend_too_soon" }) as never,
    )

    const result = await auth.resendEmailVerification("chl_1")
    await flush()

    expect(result.errorCode).toBe("email_verification_resend_limited")
    expect(sendEmailVerification).not.toHaveBeenCalled()
  })
})

describe("without email configured", () => {
  it("logs the code outside production so local sign-in works", async () => {
    configured = false
    process.env.NODE_ENV = "development"
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const { auth } = makeAuthService()

    await login(auth)
    await flush()

    expect(warn.mock.calls.some((args) => String(args[0]).includes("424242"))).toBe(true)
    warn.mockRestore()
  })

  it("never logs the code in production", async () => {
    configured = false
    process.env.NODE_ENV = "production"
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const error = spyOn(console, "error").mockImplementation(() => {})
    const { auth } = makeAuthService()

    await login(auth)
    await flush()

    const logged = [...warn.mock.calls, ...error.mock.calls].map((args) =>
      args.map(String).join(" "),
    )
    expect(logged.some((line) => line.includes("424242"))).toBe(false)
    warn.mockRestore()
    error.mockRestore()
  })
})
