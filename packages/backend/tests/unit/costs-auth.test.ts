/**
 * Costs API key auth — unit tests (task_6de67c22b163387a).
 *
 * Covers the full auth matrix of the /api/costs/* surface:
 *   - key resolution (secret file wins over env, blanks unset)
 *   - timing-safe match + fingerprint (never the key itself)
 *   - environment label resolution
 *   - scope guard: X-API-Key on any non-costs path → violation
 *   - rate limiter: fixed window, limit, retry-after, disable, reset
 *   - HTTP matrix: 404 disabled · 401 missing/invalid (identical bodies) ·
 *     429 over limit · 405 non-GET · 400 bad params · 200 valid ·
 *     404 unknown endpoint (generic body)
 *   - access log entries written with the right outcome per branch
 *
 * Run: bun test packages/backend/tests/unit/costs-auth.test.ts
 */

import { describe, expect, it, mock } from "bun:test"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Db } from "mongodb"
import { createCostsRoutes } from "../../src/routes/costs-routes"
import {
  apiKeyMatches,
  checkApiKeyScope,
  CostsKeyRateLimiter,
  costsAccessLogger,
  extractApiKey,
  keyFingerprint,
  parseRateLimitPerMin,
  resolveCostsApiKeyFrom,
  resolveCostsEnv,
  type CostsAccessLogEntry,
} from "../../src/services/costs-auth"

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RecordedLog {
  coll: string
  entry: CostsAccessLogEntry
}

/** Fake Db capturing costs_access_logs inserts; aggregation collections unused here. */
function createAuthTestDb(recorded: RecordedLog[]): Db {
  return {
    collection: (name: string) => ({
      insertOne: mock(async (entry: CostsAccessLogEntry) => {
        recorded.push({ coll: name, entry })
        return { acknowledged: true }
      }),
      aggregate: () => ({ toArray: mock(async () => []) }),
      find: () => ({ toArray: mock(async () => []) }),
    }),
  } as unknown as Db
}

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers, method: "GET" } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse; status: () => number; body: () => any; headers: () => Record<string, string | string[]> } {
  const state: { statusCode?: number; chunks: string[]; hdrs: Record<string, string | string[]> } = {
    statusCode: undefined,
    chunks: [],
    hdrs: {},
  }
  const res = {
    writeHead: (status: number, headers?: Record<string, string | string[]>) => {
      state.statusCode = status
      if (headers) Object.assign(state.hdrs, headers)
    },
    end: (chunk?: string) => {
      if (chunk) state.chunks.push(chunk)
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => state.statusCode ?? -1,
    body: () => (state.chunks.length ? JSON.parse(state.chunks.join("")) : null),
    headers: () => state.hdrs,
  }
}

const KEY = "a".repeat(64)
const OTHER_KEY = "b".repeat(64)

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

describe("resolveCostsApiKeyFrom", () => {
  it("secret-file value wins over the env var", () => {
    expect(resolveCostsApiKeyFrom("from-secrets", "from-env")).toBe("from-secrets")
  })

  it("falls back to the env var when the secret is unset", () => {
    expect(resolveCostsApiKeyFrom(undefined, "from-env")).toBe("from-env")
    expect(resolveCostsApiKeyFrom(null, "from-env")).toBe("from-env")
  })

  it("blank/whitespace values count as unset (null → surface disabled)", () => {
    expect(resolveCostsApiKeyFrom("", "from-env")).toBe("from-env")
    expect(resolveCostsApiKeyFrom("   ", "from-env")).toBe("from-env")
    expect(resolveCostsApiKeyFrom("", "")).toBeNull()
    expect(resolveCostsApiKeyFrom(undefined, "   ")).toBeNull()
  })

  it("trims the winning value", () => {
    expect(resolveCostsApiKeyFrom("  padded  ", undefined)).toBe("padded")
  })
})

describe("apiKeyMatches", () => {
  it("matches the exact key and rejects anything else", () => {
    expect(apiKeyMatches(KEY, KEY)).toBe(true)
    expect(apiKeyMatches(OTHER_KEY, KEY)).toBe(false)
    expect(apiKeyMatches(KEY + "x", KEY)).toBe(false)
    expect(apiKeyMatches("", KEY)).toBe(false)
  })

  it("never matches when no key is configured (disabled surface)", () => {
    expect(apiKeyMatches(KEY, null)).toBe(false)
    expect(apiKeyMatches("", null)).toBe(false)
  })
})

describe("keyFingerprint", () => {
  it("is a 12-hex-char sha256 prefix of the key — never the key itself", () => {
    const fp = keyFingerprint(KEY)
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
    expect(fp.length).toBe(12)
    expect(KEY.includes(fp)).toBe(false)
  })

  it("is deterministic and differs between keys", () => {
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY))
    expect(keyFingerprint(KEY)).not.toBe(keyFingerprint(OTHER_KEY))
  })
})

// ---------------------------------------------------------------------------
// Environment label
// ---------------------------------------------------------------------------

describe("resolveCostsEnv", () => {
  it("COSTS_ENV override wins over everything", () => {
    expect(resolveCostsEnv("https://raw-be.teros.ai", "development", "prod")).toBe("prod")
  })

  it("SERVER_BASE_URL host wins: raw-be before the generic be.teros.ai match", () => {
    expect(resolveCostsEnv("https://raw-be.teros.ai", "development", undefined)).toBe("raw")
    expect(resolveCostsEnv("https://pre-be.teros.ai", "development", undefined)).toBe("pre")
    expect(resolveCostsEnv("https://be.teros.ai", "production", undefined)).toBe("prod")
  })

  it("falls back to NODE_ENV and then dev", () => {
    expect(resolveCostsEnv(undefined, "production", undefined)).toBe("prod")
    expect(resolveCostsEnv(undefined, "development", undefined)).toBe("dev")
    expect(resolveCostsEnv("", "", "")).toBe("dev")
  })
})

// ---------------------------------------------------------------------------
// Header extraction + scope guard
// ---------------------------------------------------------------------------

describe("extractApiKey", () => {
  it("reads the x-api-key header (node lowercases it)", () => {
    expect(extractApiKey(fakeReq({ "x-api-key": KEY }))).toBe(KEY)
  })

  it("trims; null when absent, empty or whitespace", () => {
    expect(extractApiKey(fakeReq({ "x-api-key": `  ${KEY}  ` }))).toBe(KEY)
    expect(extractApiKey(fakeReq({}))).toBeNull()
    expect(extractApiKey(fakeReq({ "x-api-key": "" }))).toBeNull()
    expect(extractApiKey(fakeReq({ "x-api-key": "   " }))).toBeNull()
  })

  it("takes the first value when the header is duplicated (array form)", () => {
    expect(extractApiKey({ headers: { "x-api-key": [KEY, OTHER_KEY] } } as unknown as IncomingMessage)).toBe(KEY)
  })
})

describe("checkApiKeyScope — the key authorizes ONLY /api/costs/*", () => {
  it("no header → never a violation, any path", () => {
    for (const url of ["/api/costs/overview", "/health", "/", "/api/tasks/x"]) {
      const check = checkApiKeyScope(fakeReq({}), url)
      expect(check.violation).toBe(false)
      expect(check.keyFingerprint).toBeNull()
    }
  })

  it("header + costs path → allowed (no violation)", () => {
    for (const url of ["/api/costs/overview", "/api/costs/weekly?from=x", "/api/costs/"]) {
      expect(checkApiKeyScope(fakeReq({ "x-api-key": KEY }), url).violation).toBe(false)
    }
  })

  it("header + ANY other path → violation, valid key or not", () => {
    for (const url of [
      "/health",
      "/metrics",
      "/api/tasks/dep",
      "/api/mca-event",
      "/admin/restart",
      "/api/costs-overview", // prefix-lookalike, NOT under /api/costs/
      "/",
    ]) {
      const check = checkApiKeyScope(fakeReq({ "x-api-key": KEY }), url)
      expect(check.violation).toBe(true)
      expect(check.keyFingerprint).toBe(keyFingerprint(KEY))
    }
    // An INVALID key is equally a scope violation — the guard is about where
    // the credential may be used, not whether it is correct.
    expect(checkApiKeyScope(fakeReq({ "x-api-key": OTHER_KEY }), "/health").violation).toBe(true)
  })

  it("path is stripped of the query string", () => {
    expect(checkApiKeyScope(fakeReq({ "x-api-key": KEY }), "/health?a=1").path).toBe("/health")
    expect(checkApiKeyScope(fakeReq({ "x-api-key": KEY }), "/api/costs/overview?from=x").path).toBe(
      "/api/costs/overview",
    )
  })
})

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe("CostsKeyRateLimiter", () => {
  it("allows up to the limit inside the window, then denies with retry-after", () => {
    let t = 1_000_000
    const rl = new CostsKeyRateLimiter(3, 60_000, () => t)
    expect(rl.check("k").allowed).toBe(true)
    expect(rl.check("k").allowed).toBe(true)
    expect(rl.check("k").allowed).toBe(true)
    const denied = rl.check("k")
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    // Window is 60s from the first hit at t: retry ≈ 60s.
    expect(denied.retryAfterSeconds).toBe(60)
  })

  it("resets when the window elapses", () => {
    let t = 0
    const rl = new CostsKeyRateLimiter(2, 60_000, () => t)
    expect(rl.check("k").allowed).toBe(true)
    expect(rl.check("k").allowed).toBe(true)
    expect(rl.check("k").allowed).toBe(false)
    t = 60_001
    expect(rl.check("k").allowed).toBe(true)
  })

  it("tracks each key fingerprint independently", () => {
    let t = 0
    const rl = new CostsKeyRateLimiter(1, 60_000, () => t)
    expect(rl.check("keyA").allowed).toBe(true)
    expect(rl.check("keyA").allowed).toBe(false)
    expect(rl.check("keyB").allowed).toBe(true)
  })

  it("limit 0 disables the limiter entirely", () => {
    const rl = new CostsKeyRateLimiter(0)
    expect(rl.disabled).toBe(true)
    for (let i = 0; i < 100; i++) expect(rl.check("k").allowed).toBe(true)
  })
})

describe("parseRateLimitPerMin", () => {
  it("defaults to 60; 0 disables; garbage fails closed to the default", () => {
    expect(parseRateLimitPerMin(undefined)).toBe(60)
    expect(parseRateLimitPerMin("")).toBe(60)
    expect(parseRateLimitPerMin("0")).toBe(0)
    expect(parseRateLimitPerMin("120")).toBe(120)
    expect(parseRateLimitPerMin("-5")).toBe(60)
    expect(parseRateLimitPerMin("abc")).toBe(60)
    expect(parseRateLimitPerMin("2.9")).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// HTTP matrix — createCostsRoutes with the auth layer
// ---------------------------------------------------------------------------

describe("createCostsRoutes — auth matrix", () => {
  function setup(opts?: { apiKey?: string | null; limit?: number }) {
    const recorded: RecordedLog[] = []
    costsAccessLogger.resetForTests()
    costsAccessLogger.init(createAuthTestDb(recorded))
    const handler = createCostsRoutes({
      db: createAuthTestDb([]),
      apiKey: opts?.apiKey === undefined ? KEY : opts.apiKey,
      env: "raw",
      rateLimitPerMin: opts?.limit,
    })
    return { handler, recorded }
  }

  it("no key configured → 404 with a generic body (surface disabled)", async () => {
    const { handler, recorded } = setup({ apiKey: null })
    const r = fakeRes()
    expect(await handler(fakeReq({}), r.res, "/api/costs/overview")).toBe(true)
    expect(r.status()).toBe(404)
    expect(r.body()).toEqual({ error: "NOT_FOUND", message: "Not Found" })
    // Even the disabled branch is audited.
    expect(recorded.length).toBe(1)
    expect(recorded[0].entry.outcome).toBe("disabled")
    expect(recorded[0].coll).toBe("costs_access_logs")
  })

  it("missing key → 401; invalid key → 401 with the IDENTICAL body (no oracle)", async () => {
    const { handler } = setup()
    const missing = fakeRes()
    expect(await handler(fakeReq({}), missing.res, "/api/costs/overview")).toBe(true)
    expect(missing.status()).toBe(401)
    const invalid = fakeRes()
    expect(await handler(fakeReq({ "x-api-key": OTHER_KEY }), invalid.res, "/api/costs/overview")).toBe(true)
    expect(invalid.status()).toBe(401)
    expect(missing.body()).toEqual(invalid.body())
    expect(missing.body()).toEqual({ error: "UNAUTHORIZED", message: "API key required" })
  })

  it("valid key → rate limit applies → 429 with Retry-After past the limit", async () => {
    const { handler, recorded } = setup({ limit: 2 })
    const url = "/api/costs/overview?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z"
    for (let i = 0; i < 2; i++) {
      const r = fakeRes()
      expect(await handler(fakeReq({ "x-api-key": KEY }), r.res, url)).toBe(true)
      expect(r.status()).toBe(200)
    }
    const denied = fakeRes()
    expect(await handler(fakeReq({ "x-api-key": KEY }), denied.res, url)).toBe(true)
    expect(denied.status()).toBe(429)
    expect(denied.headers()["Retry-After"]).toBeDefined()
    expect(denied.body().retryAfterSeconds).toBeGreaterThan(0)
    expect(recorded.at(-1)?.entry.outcome).toBe("rate_limited")
  })

  it("valid key + POST → 405 (read-only surface)", async () => {
    const { handler } = setup()
    const r = fakeRes()
    const post = { headers: { "x-api-key": KEY }, method: "POST" } as unknown as IncomingMessage
    expect(await handler(post, r.res, "/api/costs/overview")).toBe(true)
    expect(r.status()).toBe(405)
  })

  it("valid key + bad params → 400, audited with the requested window", async () => {
    const { handler, recorded } = setup()
    const r = fakeRes()
    const url = "/api/costs/overview?from=not-a-date&to=2026-11-01T00:00:00Z"
    expect(await handler(fakeReq({ "x-api-key": KEY }), r.res, url)).toBe(true)
    expect(r.status()).toBe(400)
    const entry = recorded.at(-1)?.entry
    expect(entry?.outcome).toBe("bad_request")
    expect(entry?.from).toBe("not-a-date")
    expect(entry?.to).toBe("2026-11-01T00:00:00Z")
  })

  it("valid key + unknown costs endpoint → 404 with a GENERIC body (no endpoint echo)", async () => {
    const { handler } = setup()
    const r = fakeRes()
    expect(await handler(fakeReq({ "x-api-key": KEY }), r.res, "/api/costs/nope")).toBe(true)
    expect(r.status()).toBe(404)
    expect(r.body()).toEqual({ error: "NOT_FOUND", message: "Not Found" })
    expect(JSON.stringify(r.body())).not.toContain("nope")
  })

  it("valid key + overview → 200 and audited as ok with from/to/seg", async () => {
    const { handler, recorded } = setup()
    const r = fakeRes()
    const url = "/api/costs/overview?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z"
    expect(await handler(fakeReq({ "x-api-key": KEY }), r.res, url)).toBe(true)
    expect(r.status()).toBe(200)
    const entry = recorded.at(-1)?.entry
    expect(entry?.outcome).toBe("ok")
    expect(entry?.status).toBe(200)
    expect(entry?.from).toBe("2026-10-01T00:00:00Z")
    expect(entry?.to).toBe("2026-11-01T00:00:00Z")
    expect(entry?.seg).toBeNull()
    expect(entry?.env).toBe("raw")
    expect(entry?.keyFingerprint).toBe(keyFingerprint(KEY))
  })

  it("audit entries never contain the key itself", async () => {
    const { handler, recorded } = setup()
    const r = fakeRes()
    await handler(fakeReq({ "x-api-key": KEY }), r.res, "/api/costs/overview")
    const serialized = JSON.stringify(recorded)
    expect(serialized.includes(KEY)).toBe(false)
  })

  it("non-costs paths are not handled by the factory (returns false)", async () => {
    const { handler } = setup()
    expect(await handler(fakeReq({ "x-api-key": KEY }), fakeRes().res, "/health")).toBe(false)
    expect(await handler(fakeReq({}), fakeRes().res, "/api/tasks/dep")).toBe(false)
  })
})
