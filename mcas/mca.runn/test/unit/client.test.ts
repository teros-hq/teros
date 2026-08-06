import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { buildUrl, resolveRetryDelay, runnList, runnRequest } from "../../src/lib/runn-client"
import { RunnApiError } from "../../src/lib/runn-error"
import { firstOf } from "../../src/tools/utils"

// ---------------------------------------------------------------------------
// Test doubles — a faithful `fetch` mock using real Response/Headers so header
// access and body parsing behave exactly like the runtime boundary.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string
  init: RequestInit
}

let fetchCalls: FetchCall[] = []
let responseQueue: Response[] = []
const originalFetch = globalThis.fetch

function queue(...responses: Response[]): void {
  responseQueue.push(...responses)
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function makeContext(secrets: Record<string, string> = { API_KEY: "LIVE_test" }): any {
  return {
    execution: { userId: "u_1", appId: "app_1" },
    backend: null,
    signal: new AbortController().signal,
    getUserSecrets: async () => secrets,
    getSystemSecrets: async () => ({}),
    updateUserSecrets: async () => {},
    getScope: () => "u_1",
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
  }
}

async function catchError(fn: () => Promise<unknown>): Promise<RunnApiError> {
  try {
    await fn()
  } catch (err) {
    return err as RunnApiError
  }
  throw new Error("expected the call to reject, but it resolved")
}

beforeEach(() => {
  fetchCalls = []
  responseQueue = []
  globalThis.fetch = (async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init })
    const r = responseQueue.shift()
    if (!r) throw new Error("fetch called more times than responses were queued")
    return r
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------

describe("buildUrl", () => {
  it("joins base + endpoint and serialises defined query params only", () => {
    const url = new URL(buildUrl("/projects", { limit: 50, cursor: undefined, isArchived: false }))
    expect(url.origin + url.pathname).toBe("https://api.runn.io/projects")
    expect(url.searchParams.get("limit")).toBe("50")
    expect(url.searchParams.get("isArchived")).toBe("false")
    expect(url.searchParams.has("cursor")).toBe(false)
  })
})

describe("resolveRetryDelay", () => {
  it("honours a numeric Retry-After (seconds → ms)", () => {
    expect(resolveRetryDelay("2", 0)).toBe(2000)
  })
  it("clamps to 30s", () => {
    expect(resolveRetryDelay("100", 0)).toBe(30_000)
  })
  it("falls back to the schedule when header is absent or non-numeric or negative", () => {
    expect(resolveRetryDelay(null, 0)).toBe(800)
    expect(resolveRetryDelay(null, 1)).toBe(2000)
    expect(resolveRetryDelay("abc", 0)).toBe(800)
    expect(resolveRetryDelay("-5", 0)).toBe(800)
    expect(resolveRetryDelay(null, 99)).toBe(5000) // out-of-range attempt → default
  })
})

describe("runnRequest auth + headers", () => {
  it("throws AUTH_REQUIRED without hitting the network when no API key", async () => {
    const err = await catchError(() => runnRequest("/projects", makeContext({})))
    expect(err).toBeInstanceOf(RunnApiError)
    expect(err.code).toBe("AUTH_REQUIRED")
    expect(err.message).toContain("[AUTH_REQUIRED]")
    expect(fetchCalls.length).toBe(0)
  })

  it("sends Bearer token + Accept-Version on a GET and returns parsed JSON", async () => {
    queue(json({ id: 7, name: "Apollo" }))
    const result = await runnRequest("/projects/7", makeContext())
    expect(result).toEqual({ id: 7, name: "Apollo" })
    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer LIVE_test")
    expect(headers["Accept-Version"]).toBe("1.0.0")
    expect(fetchCalls[0].init.method).toBe("GET")
    // Bodyless requests must NOT declare a JSON content-type — Runn's Fastify
    // server 400s with FST_ERR_CTP_EMPTY_JSON_BODY otherwise (this broke DELETE).
    expect(headers["Content-Type"]).toBeUndefined()
  })

  it("sends Content-Type + serialised body on a POST", async () => {
    queue(json([{ id: 9 }]))
    await runnRequest("/projects", makeContext(), {
      method: "POST",
      body: { name: "X", clientId: 1 },
    })
    const init = fetchCalls[0].init
    const headers = init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ name: "X", clientId: 1 }))
    expect(init.method).toBe("POST")
  })

  it("returns undefined on 204 No Content", async () => {
    queue(new Response(null, { status: 204 }))
    const result = await runnRequest("/assignments/5", makeContext(), { method: "DELETE" })
    expect(result).toBeUndefined()
  })
})

describe("runnRequest retry policy", () => {
  it("retries an idempotent GET on 429 then succeeds (Retry-After honoured)", async () => {
    queue(
      json({ error: "rate", statusCode: 429, message: "slow down" }, 429, { "retry-after": "0" }),
      json({ id: 1 }),
    )
    const result = await runnRequest("/projects", makeContext())
    expect(result).toEqual({ id: 1 })
    expect(fetchCalls.length).toBe(2)
  })

  it("gives up after MAX_RETRIES on persistent 500 and classifies the error", async () => {
    queue(
      ...Array.from({ length: 4 }, () =>
        json({ error: "boom", statusCode: 500, message: "server error" }, 500, {
          "retry-after": "0",
        }),
      ),
    )
    const err = await catchError(() => runnRequest("/projects", makeContext()))
    expect(err).toBeInstanceOf(RunnApiError)
    expect(err.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(err.message).toContain("server error") // upstream message preserved
    expect(fetchCalls.length).toBe(4) // 1 initial + 3 retries
  })

  it("does NOT retry a mutating POST on 500 — fails fast to avoid duplicates", async () => {
    queue(
      json({ error: "boom", statusCode: 500, message: "server error" }, 500, {
        "retry-after": "0",
      }),
    )
    const err = await catchError(() =>
      runnRequest("/assignments", makeContext(), { method: "POST", body: { x: 1 } }),
    )
    expect(err).toBeInstanceOf(RunnApiError)
    expect(fetchCalls.length).toBe(1) // single attempt, no retry
  })

  it("maps 401 to AUTH_INVALID without retrying", async () => {
    queue(json({ error: "unauthorized", statusCode: 401, message: "bad token" }, 401))
    const err = await catchError(() => runnRequest("/me", makeContext()))
    expect(err.code).toBe("AUTH_INVALID")
    expect(err.message).toContain("bad token")
    expect(fetchCalls.length).toBe(1)
  })

  it("maps 403 to PERMISSION_DENIED (read-only token writing)", async () => {
    queue(json({ error: "forbidden", statusCode: 403, message: "write scope required" }, 403))
    const err = await catchError(() =>
      runnRequest("/projects", makeContext(), { method: "POST", body: {} }),
    )
    expect(err.code).toBe("PERMISSION_DENIED")
    expect(fetchCalls.length).toBe(1)
  })
})

describe("runnList pagination envelope", () => {
  it("passes limit/cursor as query and returns { values, nextCursor }", async () => {
    queue(json({ values: [{ id: 1 }, { id: 2 }], nextCursor: "abc" }))
    const page = await runnList("/projects", makeContext(), { limit: 50, cursor: "prev" })
    expect(page.values).toEqual([{ id: 1 }, { id: 2 }])
    expect(page.nextCursor).toBe("abc")
    const url = new URL(fetchCalls[0].url)
    expect(url.searchParams.get("limit")).toBe("50")
    expect(url.searchParams.get("cursor")).toBe("prev")
  })

  it("normalises a missing values/nextCursor to [] and null", async () => {
    queue(json({}))
    const page = await runnList("/teams", makeContext())
    expect(page.values).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})

describe("firstOf (Runn POST/PATCH returns an array)", () => {
  it("takes the first element of an array", () => {
    // Runn's POST /assignments returns `[{...}]` even for a single create.
    expect(firstOf([{ id: 1 }, { id: 2 }])).toEqual({ id: 1 })
  })
  it("passes a bare object through unchanged", () => {
    expect(firstOf({ id: 9 })).toEqual({ id: 9 })
  })
})
