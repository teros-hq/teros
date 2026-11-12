/**
 * Sign-in provisioning (SIP): every successful sign-in leaves the user with a
 * Private workspace and a default agent, without ever blocking the sign-in.
 *
 * Users created outside registration (the installer's create-user script)
 * used to land on "No workspace to load" with no agent at all.
 */
import { describe, expect, it, mock } from "bun:test"
import { AuthService } from "../../src/auth/auth-service"
import { UserService } from "../../src/auth/user-service"

const user = {
  userId: "usr_1",
  status: "active",
  emailVerified: true,
  profile: { email: "admin@example.com", displayName: "Admin" },
}

function makeAuthService(overrides: { ensure?: unknown; agent?: unknown } = {}) {
  const auth = new AuthService({ collection: () => ({}) } as never)
  const ensurePrivateWorkspace =
    (overrides.ensure as ReturnType<typeof mock>) ??
    mock(() => Promise.resolve({ workspaceId: "ws_private" }))
  const createDefaultAgentIfNeeded =
    (overrides.agent as ReturnType<typeof mock>) ?? mock(() => Promise.resolve(null))
  Object.assign(auth, {
    userService: {
      getByUserId: mock(() => Promise.resolve(user)),
      updateLastLogin: mock(() => Promise.resolve()),
      ensurePrivateWorkspace,
    },
    identityService: {
      verifyPassword: mock(() =>
        Promise.resolve({ success: true, identity: { _id: "idn_1", userId: "usr_1" } }),
      ),
    },
    sessionService: {
      createSession: mock(() => Promise.resolve({ sessionId: "ses_1", token: "tok_1", expiresAt: new Date() })),
    },
    defaultAgentService: { createDefaultAgentIfNeeded },
  })
  return { auth, ensurePrivateWorkspace, createDefaultAgentIfNeeded }
}

const login = (auth: AuthService) =>
  auth.loginWithPassword({ email: "admin@example.com", password: "pw", ipAddress: "127.0.0.1", userAgent: "test" } as never)

describe("AuthService sign-in provisioning", () => {
  it("[SIP-AC-2] a password sign-in provisions the Private workspace and the default agent", async () => {
    const { auth, ensurePrivateWorkspace, createDefaultAgentIfNeeded } = makeAuthService()
    const result = await login(auth)
    expect(result.success).toBe(true)
    expect(ensurePrivateWorkspace).toHaveBeenCalledWith("usr_1")
    expect(createDefaultAgentIfNeeded).toHaveBeenCalledWith("usr_1")
  })

  it("[SIP-AC-3] a failing workspace step neither blocks the sign-in nor skips the agent step", async () => {
    const { auth, createDefaultAgentIfNeeded } = makeAuthService({
      ensure: mock(() => Promise.reject(new Error("workspaces down"))),
    })
    const result = await login(auth)
    expect(result.success).toBe(true)
    expect(createDefaultAgentIfNeeded).toHaveBeenCalledWith("usr_1")
  })

  it("[SIP-AC-3] a failing agent step does not block the sign-in", async () => {
    const { auth, ensurePrivateWorkspace } = makeAuthService({
      agent: mock(() => Promise.reject(new Error("no core"))),
    })
    const result = await login(auth)
    expect(result.success).toBe(true)
    expect(ensurePrivateWorkspace).toHaveBeenCalledWith("usr_1")
  })
})

describe("UserService.ensurePrivateWorkspace", () => {
  function makeUserService(existing: { privateWorkspaceId?: string } | null) {
    const updateOne = mock(() => Promise.resolve({ matchedCount: 1 }))
    const findOne = mock(() => Promise.resolve(existing ? { userId: "usr_1", ...existing } : null))
    const db = { collection: () => ({ findOne, updateOne }) } as never
    const svc = new UserService(db)
    const createPrivateWorkspace = mock(() => Promise.resolve({ workspaceId: "ws_private" }))
    svc.setWorkspaceService({ createPrivateWorkspace } as never)
    return { svc, createPrivateWorkspace, updateOne }
  }

  it("[SIP-AC-1] creates the workspace and writes privateWorkspaceId when missing", async () => {
    const { svc, createPrivateWorkspace, updateOne } = makeUserService({})
    const ws = await svc.ensurePrivateWorkspace("usr_1")
    expect(ws?.workspaceId).toBe("ws_private")
    expect(createPrivateWorkspace).toHaveBeenCalledWith("usr_1")
    expect(updateOne).toHaveBeenCalledTimes(1)
  })

  it("[SIP-AC-1] is a no-op write when the user already points at it", async () => {
    const { svc, updateOne } = makeUserService({ privateWorkspaceId: "ws_private" })
    const ws = await svc.ensurePrivateWorkspace("usr_1")
    expect(ws?.workspaceId).toBe("ws_private")
    expect(updateOne).not.toHaveBeenCalled()
  })

  it("[SIP-AC-1] returns null when no WorkspaceService is bound", async () => {
    const svc = new UserService({ collection: () => ({}) } as never)
    expect(await svc.ensurePrivateWorkspace("usr_1")).toBeNull()
  })
})
