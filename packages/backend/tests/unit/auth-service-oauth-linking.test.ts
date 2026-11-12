/**
 * AuthService.loginWithOAuth linking rules (SEC-1, part 3).
 *
 * Auto-linking by email hands an account to whoever controls the address, so:
 *   - a revoked identity can't sign in again;
 *   - only an email the provider vouches for can claim an existing account
 *     (Microsoft never does);
 *   - an account that never proved its email loses its unproven credentials
 *     and sessions when a vouched OAuth identity claims it (pre-hijacking);
 *   - a verified account is simply linked.
 */

import { afterAll, describe, expect, it, mock } from "bun:test"

import * as emailModule from "../../src/services/email-service"

// createOAuthUser sends a welcome email: keep it off the network.
mock.module("../../src/services/email-service", () => ({
  ...emailModule,
  isEmailConfigured: () => false,
}))

import { AuthService, type OAuthLoginParams } from "../../src/auth/auth-service"

afterAll(() => {
  mock.restore()
})

const owner = {
  userId: "usr_owner",
  status: "active",
  emailVerified: true,
  accessGranted: true,
  profile: { email: "dana@example.com", displayName: "Dana" },
}

const google: OAuthLoginParams = {
  provider: "google",
  providerUserId: "g_1",
  email: "Dana@Example.com",
  emailVerified: true,
  displayName: "Dana",
}

function makeAuthService(
  opts: {
    existingIdentity?: Record<string, unknown> | null
    userByEmail?: Record<string, unknown> | null
    ownerIdentities?: Array<Record<string, unknown>>
  } = {},
) {
  const auth = new AuthService({ collection: () => ({}) } as never)
  const stubs = {
    userService: {
      getByEmail: mock(() => Promise.resolve(opts.userByEmail ?? null)),
      getByUserId: mock(() => Promise.resolve(opts.userByEmail ?? owner)),
      createUser: mock((p: Record<string, unknown>) =>
        Promise.resolve({ ...owner, userId: "usr_new", emailVerified: p.emailVerified }),
      ),
      markEmailVerified: mock(() => Promise.resolve()),
      activatePendingMemberships: mock(() => Promise.resolve()),
      updateLastLogin: mock(() => Promise.resolve()),
      updateProfile: mock(() => Promise.resolve()),
    },
    identityService: {
      getByProvider: mock(() => Promise.resolve(opts.existingIdentity ?? null)),
      getAnyByEmail: mock(() => Promise.resolve(null)),
      getByUserId: mock(() => Promise.resolve(opts.ownerIdentities ?? [])),
      revokeIdentity: mock(() => Promise.resolve()),
      upsertOAuthIdentity: mock(() => Promise.resolve({ _id: "idn_oauth" })),
    },
    sessionService: {
      createSession: mock(() => Promise.resolve({ token: "tok_1" })),
      revokeAllUserSessions: mock(() => Promise.resolve(2)),
    },
    defaultAgentService: {
      createDefaultAgentIfNeeded: mock(() => Promise.resolve()),
    },
  }
  Object.assign(auth, stubs)
  return { auth, stubs }
}

describe("existing OAuth identity", () => {
  it("signs in an active identity", async () => {
    const { auth } = makeAuthService({
      existingIdentity: { _id: "idn_1", userId: "usr_owner", status: "active" },
    })

    const result = await auth.loginWithOAuth(google)

    expect(result.success).toBe(true)
  })

  it("refuses a revoked identity", async () => {
    const { auth, stubs } = makeAuthService({
      existingIdentity: { _id: "idn_1", userId: "usr_owner", status: "revoked" },
    })

    const result = await auth.loginWithOAuth(google)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("identity_revoked")
    expect(stubs.sessionService.createSession).not.toHaveBeenCalled()
  })
})

describe("new email", () => {
  it("creates a verified user when the provider vouches for the email", async () => {
    const { auth, stubs } = makeAuthService()

    const result = await auth.loginWithOAuth(google)

    expect(result.success).toBe(true)
    expect(stubs.userService.createUser.mock.calls[0]![0]).toMatchObject({ emailVerified: true })
  })

  it("creates an unverified user for Microsoft", async () => {
    const { auth, stubs } = makeAuthService()

    await auth.loginWithOAuth({ ...google, provider: "microsoft", emailVerified: false })

    expect(stubs.userService.createUser.mock.calls[0]![0]).toMatchObject({ emailVerified: false })
  })
})

describe("email already taken", () => {
  it("links a vouched identity to a verified account without revoking anything", async () => {
    const { auth, stubs } = makeAuthService({ userByEmail: owner })

    const result = await auth.loginWithOAuth(google)

    expect(result.success).toBe(true)
    expect(stubs.identityService.upsertOAuthIdentity.mock.calls[0]![0]).toMatchObject({
      userId: "usr_owner",
      type: "google",
    })
    expect(stubs.identityService.revokeIdentity).not.toHaveBeenCalled()
    expect(stubs.sessionService.revokeAllUserSessions).not.toHaveBeenCalled()
  })

  it("refuses to link when the provider does not vouch for the email", async () => {
    const { auth, stubs } = makeAuthService({ userByEmail: owner })

    const result = await auth.loginWithOAuth({
      ...google,
      provider: "microsoft",
      emailVerified: false,
    })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("email_exists")
    expect(stubs.identityService.upsertOAuthIdentity).not.toHaveBeenCalled()
    expect(stubs.sessionService.createSession).not.toHaveBeenCalled()
  })

  it("refuses an unverified Google email too", async () => {
    const { auth, stubs } = makeAuthService({ userByEmail: owner })

    const result = await auth.loginWithOAuth({ ...google, emailVerified: false })

    expect(result.errorCode).toBe("email_exists")
    expect(stubs.identityService.upsertOAuthIdentity).not.toHaveBeenCalled()
  })

  it("takes over an unverified account: revokes its credentials and sessions, then links", async () => {
    const squatted = { ...owner, emailVerified: false }
    const { auth, stubs } = makeAuthService({
      userByEmail: squatted,
      ownerIdentities: [
        { _id: "idn_pw", type: "password" },
        { _id: "idn_ms", type: "microsoft" },
      ],
    })

    const result = await auth.loginWithOAuth(google)

    expect(result.success).toBe(true)
    expect(stubs.identityService.revokeIdentity.mock.calls.map((c) => c[0])).toEqual([
      "idn_pw",
      "idn_ms",
    ])
    expect(stubs.sessionService.revokeAllUserSessions.mock.calls[0]).toEqual([
      "usr_owner",
      "security",
    ])
    expect(stubs.userService.markEmailVerified.mock.calls[0]).toEqual(["usr_owner"])
    expect(stubs.identityService.upsertOAuthIdentity.mock.calls[0]![0]).toMatchObject({
      userId: "usr_owner",
    })
    // The new session is created after the old ones were revoked
    const revokedAt = stubs.sessionService.revokeAllUserSessions.mock.invocationCallOrder[0]!
    const createdAt = stubs.sessionService.createSession.mock.invocationCallOrder[0]!
    expect(createdAt).toBeGreaterThan(revokedAt)
  })

  it("finds the owner through an identity when the profile email differs", async () => {
    const { auth, stubs } = makeAuthService({ userByEmail: null })
    stubs.identityService.getAnyByEmail.mockImplementation(
      () => Promise.resolve({ userId: "usr_owner" }) as never,
    )
    stubs.userService.getByUserId.mockImplementation(() => Promise.resolve(owner) as never)

    const result = await auth.loginWithOAuth(google)

    expect(result.success).toBe(true)
    expect(stubs.userService.createUser).not.toHaveBeenCalled()
    expect(stubs.identityService.upsertOAuthIdentity.mock.calls[0]![0]).toMatchObject({
      userId: "usr_owner",
    })
  })
})
