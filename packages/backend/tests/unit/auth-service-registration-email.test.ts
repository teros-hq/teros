/**
 * AuthService's registration-email wiring.
 *
 * Three things are covered here that the pure helper's tests
 * (registration-email.test.ts) cannot reach:
 *
 *   1. The config guard — registration must be unaffected when email is not
 *      configured, or when the EmailService cannot be constructed at all.
 *      This is the failure mode with real user impact (a 500 on signup).
 *   2. The call sites — that register() and the OAuth signup path actually
 *      invoke the helper. Without this, deleting the call would pass CI.
 *   3. That a rejected send never escapes as an unhandled rejection.
 *
 * sendRegistrationEmail resolves the EmailService via the module singleton,
 * so the two module-level functions are swapped via mock.module. We spread the
 * real module first so the EmailService class export stays intact and this
 * mock cannot leak a broken module into other suites (mock.module is
 * process-global in bun); afterAll restores it regardless.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"

const sendWelcome = mock(() => Promise.resolve({ success: true }))
const sendWelcomeRegistered = mock(() => Promise.resolve({ success: true }))
const sendEmailVerification = mock(() => Promise.resolve({ success: true }))

/** Flipped per test to drive the isEmailConfigured / getEmailService branches. */
let configured = true
let resolveService: () => unknown = () => ({
  sendWelcome,
  sendWelcomeRegistered,
  sendEmailVerification,
  // bun mock.module leaks into every later file of the run: user-service
  // grantAccess (dev-seed.test) calls sendAccessGranted on this stub.
  sendAccessGranted: mock(() => Promise.resolve({ success: true })),
})

import * as emailModule from "../../src/services/email-service"

mock.module("../../src/services/email-service", () => ({
  ...emailModule,
  isEmailConfigured: () => configured,
  getEmailService: () => resolveService(),
}))

import { AuthService } from "../../src/auth/auth-service"

const newUser = {
  userId: "usr_1",
  accessGranted: true,
  profile: { email: "new@example.com", displayName: "Dana" },
}

/**
 * An AuthService with every collaborator stubbed. The constructor only calls
 * db.collection(), so a bare fake db is enough to build the real instance —
 * we then replace the private services so register() runs end to end without
 * Mongo.
 */
function makeAuthService(user: unknown = newUser) {
  const auth = new AuthService({ collection: () => ({}) } as never)
  const stubs = {
    userService: {
      emailExists: mock(() => Promise.resolve(false)),
      getByEmail: mock(() => Promise.resolve(null)),
      createUser: mock(() => Promise.resolve(user)),
      getByUserId: mock(() => Promise.resolve(user)),
      markEmailVerified: mock(() => Promise.resolve()),
      activatePendingMemberships: mock(() => Promise.resolve()),
      updateLastLogin: mock(() => Promise.resolve()),
    },
    identityService: {
      getByProvider: mock(() => Promise.resolve(null)),
      createPasswordIdentity: mock(() => Promise.resolve({ _id: "idn_1" })),
      upsertOAuthIdentity: mock(() => Promise.resolve({ _id: "idn_1" })),
    },
    sessionService: {
      createSession: mock(() => Promise.resolve({ sessionId: "ses_1" })),
    },
    defaultAgentService: {
      createDefaultAgentIfNeeded: mock(() => Promise.resolve()),
    },
    emailVerificationService: {
      issue: mock(() => Promise.resolve({ challengeToken: "chl_1", code: "123456" })),
      verify: mock(() =>
        Promise.resolve({
          success: true,
          challenge: { userId: "usr_1", identityId: "idn_1", purpose: "register" },
        }),
      ),
    },
  }
  Object.assign(auth, stubs)
  return auth
}

/** sendRegistrationEmail is void-ed by its callers; let its microtasks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Invoke the private helper directly, on a real (stubbed) instance. */
function sendRegistrationEmail(auth: AuthService, user: unknown): Promise<void> {
  // @ts-expect-error — private helper, reached deliberately for branch coverage
  return auth.sendRegistrationEmail(user)
}

afterAll(() => {
  // bun mock.module leaks into every later file of the run and mock.restore()
  // does not undo it: leave the leaked module answering "email not configured"
  // so no later suite (dev-seed → user-service.grantAccess) walks into this stub.
  configured = false
  mock.restore()
})

beforeEach(() => {
  configured = true
  resolveService = () => ({ sendWelcome, sendWelcomeRegistered, sendEmailVerification })
  for (const m of [sendWelcome, sendWelcomeRegistered, sendEmailVerification]) {
    m.mockReset()
    m.mockImplementation(() => Promise.resolve({ success: true }))
  }
})

describe("AuthService.sendRegistrationEmail", () => {
  it("sends 'welcome' when access is granted (no waitlist)", async () => {
    await sendRegistrationEmail(makeAuthService(), newUser)

    expect(sendWelcome).toHaveBeenCalledTimes(1)
    expect(sendWelcomeRegistered).not.toHaveBeenCalled()
    expect(sendWelcome.mock.calls[0]).toEqual(["new@example.com", { USER_NAME: "Dana" }])
  })

  it("sends 'welcome-registered' when access is not granted (legacy waitlist)", async () => {
    await sendRegistrationEmail(makeAuthService(), { ...newUser, accessGranted: false })

    expect(sendWelcomeRegistered).toHaveBeenCalledTimes(1)
    expect(sendWelcome).not.toHaveBeenCalled()
  })

  it("sends nothing when email is not configured", async () => {
    configured = false

    await sendRegistrationEmail(makeAuthService(), newUser)

    expect(sendWelcome).not.toHaveBeenCalled()
    expect(sendWelcomeRegistered).not.toHaveBeenCalled()
  })

  it("swallows a getEmailService failure instead of rejecting", async () => {
    resolveService = () => {
      throw new Error("Resend API key not configured")
    }

    // Resolving (not rejecting) is the assertion: register() void-s this call,
    // so a rejection here would surface as an unhandled rejection.
    expect(await sendRegistrationEmail(makeAuthService(), newUser)).toBeUndefined()
    expect(sendWelcome).not.toHaveBeenCalled()
  })

  it("swallows a rejected send instead of rejecting", async () => {
    sendWelcome.mockImplementation(() => Promise.reject(new Error("Resend down")))

    expect(await sendRegistrationEmail(makeAuthService(), newUser)).toBeUndefined()
    expect(sendWelcome).toHaveBeenCalledTimes(1)
  })
})

describe("registration call sites", () => {
  it("register() waits for the email code and sends no welcome yet", async () => {
    const auth = makeAuthService()

    const result = await auth.register({
      email: "New@Example.com",
      password: "pw",
      displayName: "Dana",
    })
    await flush()

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("email_verification_required")
    expect(result.session).toBeUndefined()
    expect(sendEmailVerification).toHaveBeenCalledTimes(1)
    expect(sendWelcome).not.toHaveBeenCalled()
  })

  it("verifying a registration sends the welcome email", async () => {
    const auth = makeAuthService()

    const result = await auth.completeEmailVerification("chl_1", "123456")
    await flush()

    expect(result.success).toBe(true)
    expect(sendWelcome).toHaveBeenCalledTimes(1)
    expect(sendWelcome.mock.calls[0]).toEqual(["new@example.com", { USER_NAME: "Dana" }])
  })

  it("verifying a registration still succeeds when the welcome send rejects", async () => {
    sendWelcome.mockImplementation(() => Promise.reject(new Error("Resend down")))
    const auth = makeAuthService()

    const result = await auth.completeEmailVerification("chl_1", "123456")
    await flush()

    expect(result.success).toBe(true)
  })

  it("OAuth signup sends the welcome email", async () => {
    const auth = makeAuthService()

    // @ts-expect-error — private; it is the OAuth branch's only registration path
    const result = await auth.createOAuthUser({
      provider: "google",
      providerUserId: "g_1",
      email: "new@example.com",
      emailVerified: true,
      displayName: "Dana",
    })
    await flush()

    expect(result.success).toBe(true)
    expect(sendWelcome).toHaveBeenCalledTimes(1)
  })
})

describe("register() and half-finished signups (MOD-5)", () => {
  it("reuses a user left without any identity instead of answering email_exists", async () => {
    const orphan = { ...newUser, emailVerified: false }
    const auth = makeAuthService(orphan)
    Object.assign((auth as any).userService, { getByEmail: mock(() => Promise.resolve(orphan)) })
    Object.assign((auth as any).identityService, { hasAnyIdentity: mock(() => Promise.resolve(false)) })

    const result = await auth.register({ email: "new@example.com", password: "pw", displayName: "Dana" })

    expect(result.errorCode).toBe("email_verification_required")
    expect((auth as any).userService.createUser).not.toHaveBeenCalled()
    expect((auth as any).identityService.createPasswordIdentity.mock.calls[0][0]).toMatchObject({ userId: "usr_1" })
  })

  it("still refuses an email whose user has an identity", async () => {
    const auth = makeAuthService()
    Object.assign((auth as any).userService, { getByEmail: mock(() => Promise.resolve({ ...newUser, emailVerified: false })) })
    Object.assign((auth as any).identityService, { hasAnyIdentity: mock(() => Promise.resolve(true)) })

    const result = await auth.register({ email: "new@example.com", password: "pw", displayName: "Dana" })

    expect(result.errorCode).toBe("email_exists")
    expect((auth as any).identityService.createPasswordIdentity).not.toHaveBeenCalled()
  })
})
