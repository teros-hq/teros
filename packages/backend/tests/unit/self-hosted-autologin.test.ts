/**
 * Self-hosted auto-login (spec ALOGIN): the TEROS_AUTOLOGIN switch over the dev
 * auto-login contract, accepted in production mode for a localhost-only install.
 */
import { afterEach, describe, expect, it, mock } from "bun:test"
import {
  _resetDevAutologinForTests,
  getDevAutologin,
  initDevAutologin,
  isDevAutologinRequestAllowed,
  resolveSelfHostedAutologin,
} from "../../src/auth/dev-autologin"
import { AuthService } from "../../src/auth/auth-service"
import { maybeAutoSeedDevUser } from "../../src/services/dev-seed"

const INSTALL = {
  TEROS_AUTOLOGIN: "1",
  TEROS_AUTOLOGIN_USER: "Admin@Example.com",
  NODE_ENV: "production",
  APP_URL: "http://localhost:10002",
  STATIC_BASE_URL: "http://localhost:10001/static",
}
const ENABLED = {
  enabled: true,
  userEmail: "admin@example.com",
  selfHosted: true,
  appOrigin: "http://localhost:10002",
} as const

const request = (headers: Record<string, string>, remoteAddress = "192.168.65.1") => ({
  headers,
  socket: { remoteAddress },
})

describe("self-hosted auto-login", () => {
  const savedNodeEnv = process.env.NODE_ENV
  afterEach(() => {
    _resetDevAutologinForTests()
    process.env.NODE_ENV = savedNodeEnv
  })

  it("[ALOGIN-AC-1] a localhost install in production mode is enabled as the named user; no flag is silent", () => {
    expect(resolveSelfHostedAutologin(INSTALL)).toEqual(ENABLED)
    expect(resolveSelfHostedAutologin({ ...INSTALL, TEROS_AUTOLOGIN: "true" })).toEqual(ENABLED)
    expect(resolveSelfHostedAutologin({ ...INSTALL, TEROS_AUTOLOGIN: undefined })).toEqual({ enabled: false })
    expect(resolveSelfHostedAutologin({ ...INSTALL, TEROS_AUTOLOGIN: "0" })).toEqual({ enabled: false })
    expect(resolveSelfHostedAutologin({ ...INSTALL, TEROS_AUTOLOGIN: "yes" })).toEqual({ enabled: false })
  })

  it("[ALOGIN-AC-2] anything but a localhost-only install is refused with a reason", () => {
    const refused: Array<Record<string, string | undefined>> = [
      { TEROS_AUTOLOGIN_USER: undefined },
      { TEROS_AUTOLOGIN_USER: "  " },
      { APP_URL: undefined },
      { APP_URL: "https://teros.example.com" },
      { APP_URL: "http://192.168.1.20:10002" },
      { STATIC_BASE_URL: "https://static.example.com" },
      { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
      { TEROS_EDITION: "cloud" },
      { BIND_HOST: "203.0.113.7" },
    ]
    for (const change of refused) {
      const state = resolveSelfHostedAutologin({ ...INSTALL, ...change })
      expect(state.enabled).toBe(false)
      expect((state as { refusedReason?: string }).refusedReason).toBeTruthy()
    }
    // the unspecified bind address is what a container uses
    expect(resolveSelfHostedAutologin({ ...INSTALL, BIND_HOST: "0.0.0.0" })).toEqual(ENABLED)
  })

  it("[ALOGIN-AC-3] only a loopback Host and the app's own Origin get through", () => {
    const allowed = (headers: Record<string, string>, peer?: string) =>
      isDevAutologinRequestAllowed(request(headers, peer), ENABLED)

    expect(allowed({ host: "localhost:10001", origin: "http://localhost:10002" })).toBe(true)
    expect(allowed({ host: "localhost:10001" })).toBe(true)
    expect(allowed({ host: "127.0.0.1:10001" }, "172.18.0.1")).toBe(true)

    expect(allowed({ host: "localhost:10001", origin: "http://localhost:3000" })).toBe(false)
    expect(allowed({ host: "localhost:10001", origin: "https://evil.example.com" })).toBe(false)
    expect(allowed({ host: "192.168.1.20:10001" })).toBe(false)
    expect(allowed({ host: "localhost:10001", "x-forwarded-for": "198.51.100.4" })).toBe(false)
    expect(allowed({ host: "localhost:10001" }, "198.51.100.4")).toBe(false)
  })

  it("[ALOGIN-AC-4] survives production mode, the dev switch does not, and no user is seeded", async () => {
    process.env.NODE_ENV = "production"
    expect(initDevAutologin(INSTALL)).toEqual(ENABLED)
    expect(getDevAutologin()).toEqual(ENABLED)

    _resetDevAutologinForTests({ enabled: true, userEmail: "dev@teros.local" })
    expect(getDevAutologin()).toEqual({ enabled: false })

    const insertOne = mock()
    const db = {
      collection: () => ({ findOne: async () => null, insertOne }),
    } as unknown as Parameters<typeof maybeAutoSeedDevUser>[0]
    expect(await maybeAutoSeedDevUser(db, { ...ENABLED, userEmail: "dev@teros.local" })).toBe("missing")
    expect(insertOne).not.toHaveBeenCalled()
  })

  it("[ALOGIN-AC-5] the dev switch wins when both are set", () => {
    const state = initDevAutologin({
      ...INSTALL,
      NODE_ENV: "development",
      TEROS_DEV_AUTOLOGIN: "1",
      TEROS_DEV_USER: "dev2@test.com",
    })
    expect(state).toEqual({ enabled: true, userEmail: "dev2@test.com" })
  })

  it("[ALOGIN-AC-9] a credential-less sign-in provisions the Private workspace and the default agent, and survives a failure", async () => {
    const user = { userId: "user_admin", status: "active", profile: { email: "admin@example.com" } }
    const build = (ensurePrivateWorkspace: () => Promise<unknown>) => {
      const auth = new AuthService({ collection: () => ({}) } as never)
      const stubs = {
        userService: {
          getByEmail: mock(() => Promise.resolve(user)),
          getByUserId: mock(() => Promise.resolve(user)),
          updateLastLogin: mock(() => Promise.resolve()),
          ensurePrivateWorkspace: mock(ensurePrivateWorkspace),
        },
        identityService: {
          getAnyByEmail: mock(() => Promise.resolve(null)),
          getByUserId: mock(() => Promise.resolve([{ _id: "idn_admin" }])),
        },
        sessionService: {
          createSession: mock(() => Promise.resolve({ token: "tok", session: {} })),
        },
        defaultAgentService: { createDefaultAgentIfNeeded: mock(() => Promise.resolve(null)) },
      }
      Object.assign(auth, stubs)
      return { auth, ...stubs }
    }

    const ok = build(() => Promise.resolve({}))
    expect((await ok.auth.loginAsDevUser({ email: "admin@example.com" })).success).toBe(true)
    expect(ok.userService.ensurePrivateWorkspace).toHaveBeenCalledWith("user_admin")
    expect(ok.defaultAgentService.createDefaultAgentIfNeeded).toHaveBeenCalledWith("user_admin")

    const failing = build(() => Promise.reject(new Error("no workspace")))
    expect((await failing.auth.loginAsDevUser({ email: "admin@example.com" })).success).toBe(true)
    expect(failing.defaultAgentService.createDefaultAgentIfNeeded).toHaveBeenCalledWith("user_admin")
  })
})
