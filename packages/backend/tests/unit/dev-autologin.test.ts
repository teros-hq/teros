/**
 * Dev auto-login (local development only) — the production guards.
 *
 *   (a) flag on + localhost → the dev auth frame mints a session for the dev user;
 *   (b) flag on + NODE_ENV=production → ignored, normal auth required;
 *   (c) flag on + a teros.ai base URL → ignored;
 *   (d) flag off → ignored.
 *
 * Plus the per-connection guard (direct local peer, no proxy headers, local
 * Host/Origin) and AuthService.loginAsDevUser with its collaborators stubbed.
 */

import { afterEach, describe, expect, it, mock } from "bun:test"
import { AuthService } from "../../src/auth/auth-service"
import {
  _resetDevAutologinForTests,
  getDevAutologin,
  initDevAutologin,
  isDevAutologinRequestAllowed,
  isLocalHost,
  resolveDevAutologin,
} from "../../src/auth/dev-autologin"
import { AuthHandler } from "../../src/handlers/auth-handler"

const ON = { TEROS_DEV_AUTOLOGIN: "1", TEROS_DEV_USER: "cli1@test.com" }

describe("resolveDevAutologin — boot guards", () => {
  it("(a) flag on + local env → enabled as the dev user", () => {
    expect(
      resolveDevAutologin({
        ...ON,
        NODE_ENV: "development",
        SERVER_BASE_URL: "http://localhost:10501",
      }),
    ).toEqual({
      enabled: true,
      userEmail: "cli1@test.com",
    })
  })

  it("enabled with NODE_ENV unset (plain `yarn dev`) and on a LAN address", () => {
    expect(
      resolveDevAutologin({ ...ON, SERVER_BASE_URL: "http://192.168.1.20:3000" }).enabled,
    ).toBe(true)
  })

  it("normalises TEROS_DEV_USER and defaults to the seeded dev@teros.local when unset", () => {
    expect(resolveDevAutologin({ ...ON, TEROS_DEV_USER: "  CLI1@Test.com " })).toEqual({
      enabled: true,
      userEmail: "cli1@test.com",
    })
    expect(resolveDevAutologin({ TEROS_DEV_AUTOLOGIN: "true" })).toEqual({
      enabled: true,
      userEmail: "dev@teros.local",
    })
  })
})

describe("resolveDevAutologin — refusals", () => {
  it("(b) refuses NODE_ENV=production, and staging / anything not dev or test", () => {
    for (const NODE_ENV of ["production", "Production", "staging", "prod"]) {
      const state = resolveDevAutologin({ ...ON, NODE_ENV })
      expect(state.enabled).toBe(false)
      expect(state.enabled === false && state.refusedReason).toContain("NODE_ENV")
    }
  })

  it("(c) refuses a teros.ai public URL — the dev pm2 config (NODE_ENV=development + dev-be.teros.ai)", () => {
    const state = resolveDevAutologin({
      ...ON,
      NODE_ENV: "development",
      SERVER_BASE_URL: "https://dev-be.teros.ai",
    })
    expect(state.enabled).toBe(false)
    expect(state.enabled === false && state.refusedReason).toContain("SERVER_BASE_URL")
  })

  it("refuses any public / teros.ai / unparseable URL in any public-URL env", () => {
    for (const [name, value] of [
      ["SERVER_BASE_URL", "https://be.teros.ai"],
      ["BACKEND_PUBLIC_URL", "https://dev-be.teros.ai"],
      ["APP_URL", "https://os.teros.ai"],
      ["STATIC_BASE_URL", "https://teros.ai/static"],
      ["SERVER_BASE_URL", "https://example.com"],
      ["SERVER_BASE_URL", "http://8.8.8.8:3000"],
      ["APP_URL", "not a url"],
    ]) {
      expect(resolveDevAutologin({ ...ON, [name]: value }).enabled).toBe(false)
    }
  })

  it("refuses inside Kubernetes and with a public BIND_HOST", () => {
    expect(resolveDevAutologin({ ...ON, KUBERNETES_SERVICE_HOST: "10.0.0.1" }).enabled).toBe(false)
    expect(resolveDevAutologin({ ...ON, BIND_HOST: "203.0.113.5" }).enabled).toBe(false)
    expect(resolveDevAutologin({ ...ON, BIND_HOST: "127.0.0.1" }).enabled).toBe(true)
    expect(resolveDevAutologin({ ...ON, BIND_HOST: "0.0.0.0" }).enabled).toBe(true)
  })

  it("(d) flag off (unset, 0, false, garbage) → disabled, silently", () => {
    for (const TEROS_DEV_AUTOLOGIN of [undefined, "", "0", "false", "yes"]) {
      expect(resolveDevAutologin({ TEROS_DEV_AUTOLOGIN, TEROS_DEV_USER: "cli1@test.com" })).toEqual(
        { enabled: false },
      )
    }
  })
})

describe("isLocalHost", () => {
  it("accepts localhost, loopback and private LAN; rejects public and teros.ai", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.10",
      "fd12::1",
    ]) {
      expect(isLocalHost(h)).toBe(true)
    }
    for (const h of [
      "be.teros.ai",
      "teros.ai",
      "localhost.teros.ai",
      "8.8.8.8",
      "172.32.0.1",
      "example.com",
      "",
      "1.2.3",
    ]) {
      expect(isLocalHost(h)).toBe(false)
    }
  })
})

describe("getDevAutologin — never survives production", () => {
  const originalNodeEnv = process.env.NODE_ENV
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    _resetDevAutologinForTests()
  })

  it("an enabled state reads as disabled once NODE_ENV=production", () => {
    _resetDevAutologinForTests({ enabled: true, userEmail: "cli1@test.com" })
    expect(getDevAutologin().enabled).toBe(true)
    process.env.NODE_ENV = "production"
    expect(getDevAutologin().enabled).toBe(false)
  })

  it("initDevAutologin with a refused env leaves it disabled", () => {
    expect(initDevAutologin({ ...ON, NODE_ENV: "production" }).enabled).toBe(false)
    expect(getDevAutologin().enabled).toBe(false)
  })
})

describe("isDevAutologinRequestAllowed — per-connection guard", () => {
  const enabled = { enabled: true as const, userEmail: "cli1@test.com" }
  const req = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => ({
    headers,
    socket: { remoteAddress },
  })

  it("allows a direct local connection (CLI: no Origin; browser: local Origin)", () => {
    expect(isDevAutologinRequestAllowed(req({ host: "localhost:10501" }), enabled)).toBe(true)
    expect(
      isDevAutologinRequestAllowed(req({ host: "localhost:10501" }, "::ffff:127.0.0.1"), enabled),
    ).toBe(true)
    expect(isDevAutologinRequestAllowed(req({ host: "[::1]:10501" }, "::1"), enabled)).toBe(true)
    expect(
      isDevAutologinRequestAllowed(
        req({ host: "127.0.0.1:10501", origin: "http://localhost:10502" }),
        enabled,
      ),
    ).toBe(true)
  })

  it("refuses when the feature is off", () => {
    expect(isDevAutologinRequestAllowed(req({ host: "localhost:10501" }), { enabled: false })).toBe(
      false,
    )
  })

  it("refuses proxied requests (the proxy's own address is private)", () => {
    for (const h of ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"]) {
      expect(
        isDevAutologinRequestAllowed(
          req({ host: "localhost:10501", [h]: "1.2.3.4" }, "10.0.0.2"),
          enabled,
        ),
      ).toBe(false)
    }
  })

  it("refuses a public peer, a public Host, and a cross-site browser Origin", () => {
    expect(
      isDevAutologinRequestAllowed(req({ host: "localhost:10501" }, "203.0.113.9"), enabled),
    ).toBe(false)
    expect(isDevAutologinRequestAllowed(req({}, "127.0.0.1"), enabled)).toBe(false)
    expect(isDevAutologinRequestAllowed(req({ host: "be.teros.ai" }), enabled)).toBe(false)
    expect(
      isDevAutologinRequestAllowed(
        req({ host: "localhost:10501", origin: "https://evil.example" }),
        enabled,
      ),
    ).toBe(false)
    expect(
      isDevAutologinRequestAllowed(req({ host: "localhost:10501", origin: "null" }), enabled),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The auth path itself
// ---------------------------------------------------------------------------

const devUser = {
  userId: "user_dev",
  status: "active",
  role: "super",
  emailVerified: true,
  accessGranted: true,
  profile: { email: "cli1@test.com", displayName: "CLI One" },
}

function makeAuthService(
  user: Record<string, unknown> | null = devUser,
  identities = [{ _id: "idn_dev" }],
) {
  const auth = new AuthService({ collection: () => ({}) } as never)
  const stubs = {
    userService: {
      getByEmail: mock(() => Promise.resolve(user)),
      getByUserId: mock(() => Promise.resolve(user)),
      updateLastLogin: mock(() => Promise.resolve()),
    },
    identityService: {
      getAnyByEmail: mock(() => Promise.resolve(null)),
      getByUserId: mock(() => Promise.resolve(identities)),
    },
    sessionService: {
      createSession: mock(() => Promise.resolve({ token: "tok_dev", session: {} })),
    },
  }
  Object.assign(auth, stubs)
  return { auth, ...stubs }
}

function makeHandler(auth: AuthService) {
  const handler = new AuthHandler({} as never)
  Object.assign(handler, { authService: auth })
  return handler
}

describe("AuthService.loginAsDevUser", () => {
  it("mints a normal session for TEROS_DEV_USER", async () => {
    const { auth, userService, sessionService } = makeAuthService()
    const result = await auth.loginAsDevUser({ email: "CLI1@test.com", ipAddress: "127.0.0.1" })
    expect(result.success).toBe(true)
    expect(userService.getByEmail).toHaveBeenCalledWith("cli1@test.com")
    expect(sessionService.createSession).toHaveBeenCalledWith({
      userId: "user_dev",
      identityId: "idn_dev",
      userAgent: undefined,
      ipAddress: "127.0.0.1",
    })
    expect(userService.updateLastLogin).toHaveBeenCalledWith("user_dev")
  })

  it("refuses an unknown, suspended or identity-less user, with no session", async () => {
    for (const { auth, sessionService } of [
      makeAuthService(null),
      makeAuthService({ ...devUser, status: "suspended" }),
      makeAuthService(devUser, []),
    ]) {
      const result = await auth.loginAsDevUser({ email: "cli1@test.com" })
      expect(result.success).toBe(false)
      expect(sessionService.createSession).not.toHaveBeenCalled()
    }
  })
})

describe("AuthHandler — method:'dev'", () => {
  const originalNodeEnv = process.env.NODE_ENV
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    _resetDevAutologinForTests()
  })
  const devFrame = { type: "auth", method: "dev" } as const

  it("(a) feature on + local connection → auth success as the dev user", async () => {
    _resetDevAutologinForTests({ enabled: true, userEmail: "cli1@test.com" })
    const { auth } = makeAuthService()
    const result = await makeHandler(auth).authenticate(devFrame, {
      ipAddress: "127.0.0.1",
      devAutologin: true,
    })
    expect(result.success).toBe(true)
    expect(result.userId).toBe("user_dev")
    expect(result.sessionToken).toBe("tok_dev")
    expect(result.user?.profile.email).toBe("cli1@test.com")
  })

  it("connection not vouched for (prod / proxied / cross-site) → same answer as an unknown method", async () => {
    _resetDevAutologinForTests({ enabled: true, userEmail: "cli1@test.com" })
    const { auth, sessionService } = makeAuthService()
    const handler = makeHandler(auth)
    const dev = await handler.authenticate(devFrame, { ipAddress: "127.0.0.1" })
    const unknown = await handler.authenticate({ type: "auth", method: "nope" } as never)
    expect(dev).toEqual({ success: false, error: "Unknown auth method: dev" })
    expect(unknown).toEqual({ success: false, error: "Unknown auth method: nope" })
    expect(sessionService.createSession).not.toHaveBeenCalled()
  })

  it("(b)/(d) feature off or NODE_ENV=production → refused even if the connection was vouched for", async () => {
    const { auth, sessionService } = makeAuthService()
    const handler = makeHandler(auth)
    expect((await handler.authenticate(devFrame, { devAutologin: true })).success).toBe(false)

    _resetDevAutologinForTests({ enabled: true, userEmail: "cli1@test.com" })
    process.env.NODE_ENV = "production"
    expect((await handler.authenticate(devFrame, { devAutologin: true })).success).toBe(false)
    expect(sessionService.createSession).not.toHaveBeenCalled()
  })
})
