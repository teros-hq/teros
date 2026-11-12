/**
 * Security test — Req 3.1.5: Validate userId in provider OAuth start endpoint.
 *
 * The `/api/providers/oauth/anthropic/start` endpoint must NOT trust the
 * `userId` query parameter. The authenticated userId is resolved from the
 * Bearer session token via SessionManager. If a userId query param is
 * supplied, it must match the session user — otherwise the request is
 * rejected with 403.
 *
 * MUST BITE (confirmed red against pre-fix source):
 *   - removing the resolveUserId call → any userId from query is accepted,
 *   - removing the mismatch check → attacker can impersonate any user,
 *   - removing the 401 guard → unauthenticated requests proceed.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { describe, expect, it } from "bun:test"
import { createProviderOAuthRoutes } from "../../src/routes/provider-oauth-routes"
import type { SessionManager } from "../../src/services/session-manager"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const USER_A = "user_aaa111"
const USER_B = "user_bbb222"
const TOKEN_A = "valid-token-for-user-a"

function makeMockSessionManager(): SessionManager {
  const sessions = new Map<string, { sessionId: string; userId: string }>()
  sessions.set(TOKEN_A, { sessionId: "sess-1", userId: USER_A })

  return {
    getSession: (token: string) => sessions.get(token),
  } as unknown as SessionManager
}

function makeReq(opts: {
  method?: string
  url?: string
  authHeader?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.authHeader !== undefined) {
    headers["authorization"] = opts.authHeader
  }
  return {
    method: opts.method ?? "GET",
    url: opts.url ?? "/api/providers/oauth/anthropic/start",
    headers,
  } as unknown as IncomingMessage
}

interface ResState {
  res: ServerResponse
  statusCode: number
  body: string
}

function makeRes(): ResState {
  const state = { statusCode: 0, body: "" } as ResState
  state.res = {
    writeHead: (status: number) => {
      state.statusCode = status
    },
    end: (data?: unknown) => {
      state.body = typeof data === "string" ? data : JSON.stringify(data)
    },
  } as unknown as ServerResponse
  return state
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Provider OAuth start — userId validation (Req 3.1.5)", () => {
  const sessionManager = makeMockSessionManager()
  const handler = createProviderOAuthRoutes({
    db: {} as never,
    sessionManager,
  })

  it("rejects with 401 when no Bearer token is provided", async () => {
    const req = makeReq({ url: `/api/providers/oauth/anthropic/start?userId=${USER_A}` })
    const result = makeRes()

    await handler(req, result.res, "/api/providers/oauth/anthropic/start")

    expect(result.statusCode).toBe(401)
    expect(result.body).toContain("session")
  })

  it("rejects with 401 when an invalid Bearer token is provided", async () => {
    const req = makeReq({
      url: `/api/providers/oauth/anthropic/start?userId=${USER_A}`,
      authHeader: "Bearer invalid-token",
    })
    const result = makeRes()

    await handler(req, result.res, "/api/providers/oauth/anthropic/start")

    expect(result.statusCode).toBe(401)
  })

  it("rejects with 403 when query userId does not match session user", async () => {
    // Authenticated as USER_A but claiming to be USER_B in the query param
    const req = makeReq({
      url: `/api/providers/oauth/anthropic/start?userId=${USER_B}`,
      authHeader: `Bearer ${TOKEN_A}`,
    })
    const result = makeRes()

    await handler(req, result.res, "/api/providers/oauth/anthropic/start")

    expect(result.statusCode).toBe(403)
    expect(result.body).toContain("does not match")
  })

  it("succeeds with 200 when query userId matches session user", async () => {
    const req = makeReq({
      url: `/api/providers/oauth/anthropic/start?userId=${USER_A}`,
      authHeader: `Bearer ${TOKEN_A}`,
    })
    const result = makeRes()

    await handler(req, result.res, "/api/providers/oauth/anthropic/start")

    expect(result.statusCode).toBe(200)
    const parsed = JSON.parse(result.body)
    expect(parsed.authUrl).toBeDefined()
    expect(parsed.verifier).toBeDefined()
  })

  it("succeeds with 200 when no userId query param is provided (uses session user)", async () => {
    const req = makeReq({
      url: "/api/providers/oauth/anthropic/start",
      authHeader: `Bearer ${TOKEN_A}`,
    })
    const result = makeRes()

    await handler(req, result.res, "/api/providers/oauth/anthropic/start")

    expect(result.statusCode).toBe(200)
    const parsed = JSON.parse(result.body)
    expect(parsed.authUrl).toBeDefined()
  })

  it("returns false for non-matching paths (route not handled)", async () => {
    const req = makeReq({})
    const result = makeRes()

    const handled = await handler(req, result.res, "/api/some-other-path")

    expect(handled).toBe(false)
  })

  it("rejects with 500 when sessionManager is not configured", async () => {
    const handlerNoSm = createProviderOAuthRoutes({ db: {} as never })
    const req = makeReq({
      url: `/api/providers/oauth/anthropic/start?userId=${USER_A}`,
      authHeader: `Bearer ${TOKEN_A}`,
    })
    const result = makeRes()

    await handlerNoSm(req, result.res, "/api/providers/oauth/anthropic/start")

    expect(result.statusCode).toBe(500)
    expect(result.body).toContain("not configured")
  })
})
