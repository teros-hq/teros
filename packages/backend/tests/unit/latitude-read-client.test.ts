/**
 * Unit tests for the Latitude signals read client (F4 · C2 transport + mapping).
 *
 * Mutation-verified. The strong assertions:
 *   - the EXACT request: `GET {api}/v1/projects/{slug}/signals?…` with a Bearer
 *     header and only the whitelisted, verified query-param NAMES (a typo'd name
 *     is a silently-ignored filter);
 *   - the deep link is built from the cuid `id`, NOT the slug (the web route keys
 *     on the id; the other REST endpoints key on the slug — easy to swap);
 *   - transport state maps to a discriminated outcome and NEVER throws (401/403 →
 *     unauthorized; 5xx / network / bad JSON → error).
 */

import { afterEach, describe, expect, it } from "bun:test"
import {
  buildSignalsQuery,
  createLatitudeReadClient,
  mapSignalsPage,
} from "../../src/services/latitude-read-client"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

interface StubResponse {
  status?: number
  json?: unknown
  throwNetwork?: boolean
  badJson?: boolean
}

function stubFetch(response: StubResponse) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (response.throwNetwork) throw new Error("ECONNREFUSED")
    const status = response.status ?? 200
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (response.badJson) throw new Error("invalid json")
        return response.json ?? {}
      },
      text: async () => "",
    } as Response
  }) as never
  return calls
}

const CONFIG = {
  apiBaseUrl: "http://lat.local:3011/", // trailing slash on purpose (must be stripped)
  webBaseUrl: "http://lat.local:3000/",
  token: "lat_seed_token",
  project: "default-project",
}

const RAW_SIGNAL = {
  id: "cuid_abc123",
  slug: "tool-errors",
  name: "Tool calls return generic error",
  description: "A cluster of tool_error scores",
  source: "custom",
  states: ["escalating", "ongoing"],
  mutedAt: null,
  occurrences: 12,
  affectedSessionsPercent: 0.25,
  trend: [
    { bucket: "2026-07-08", count: 3 },
    { bucket: "2026-07-09", count: 9 },
  ],
  tags: ["provider:anthropic"],
  firstSeenAt: "2026-07-08T00:00:00Z",
  lastSeenAt: "2026-07-09T10:00:00Z",
}

const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).Authorization

describe("buildSignalsQuery", () => {
  it("forwards ONLY whitelisted params, with the verified names + insertion order", () => {
    expect(
      buildSignalsQuery({
        limit: 50,
        lifecycleGroup: "active",
        sortBy: "lastSeen",
        sortDirection: "desc",
      }),
    ).toBe("limit=50&lifecycleGroup=active&sortBy=lastSeen&sortDirection=desc")
  })

  it("is empty for no params, and url-encodes the free-text query", () => {
    expect(buildSignalsQuery({})).toBe("")
    expect(buildSignalsQuery({ query: "tool error" })).toBe("query=tool+error")
    expect(buildSignalsQuery({ cursor: "eyJvZmZzZXQiOjUwfQ" })).toBe("cursor=eyJvZmZzZXQiOjUwfQ")
  })
})

describe("createLatitudeReadClient.listSignals — request", () => {
  it("hits the exact signals URL with a Bearer header (base slash stripped)", async () => {
    const calls = stubFetch({ json: { items: [], nextCursor: null, hasMore: false } })
    const client = createLatitudeReadClient(CONFIG)

    await client.listSignals({ limit: 25, lifecycleGroup: "active" })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      "http://lat.local:3011/v1/projects/default-project/signals?limit=25&lifecycleGroup=active",
    )
    expect(calls[0].init.method).toBe("GET")
    expect(authHeader(calls[0].init)).toBe("Bearer lat_seed_token")
  })

  it("omits the query string when there are no params", async () => {
    const calls = stubFetch({ json: { items: [] } })
    await createLatitudeReadClient(CONFIG).listSignals({})
    expect(calls[0].url).toBe("http://lat.local:3011/v1/projects/default-project/signals")
  })
})

describe("createLatitudeReadClient.listSignals — mapping", () => {
  it("maps a signal, deep-linking on the cuid id (NOT the slug)", async () => {
    stubFetch({ json: { items: [RAW_SIGNAL], nextCursor: "next_cur", hasMore: true } })
    const result = await createLatitudeReadClient(CONFIG).listSignals({})

    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.nextCursor).toBe("next_cur")
    expect(result.hasMore).toBe(true)
    expect(result.signals).toHaveLength(1)

    const s = result.signals[0]
    expect(s.deepLinkUrl).toBe("http://lat.local:3000/projects/default-project/signals/cuid_abc123")
    // Bite the id/slug swap: the link must NOT be built from the slug.
    expect(s.deepLinkUrl).not.toContain("tool-errors")
    expect(s.states).toEqual(["escalating", "ongoing"])
    expect(s.muted).toBe(false)
    expect(s.occurrences).toBe(12)
    expect(s.affectedSessionsPercent).toBe(0.25)
    expect(s.trend).toEqual(RAW_SIGNAL.trend)
    expect(s.tags).toEqual(["provider:anthropic"])
  })

  it("treats a set mutedAt as muted, and keeps unknown upstream states (shape-agnostic)", async () => {
    stubFetch({
      json: {
        items: [{ ...RAW_SIGNAL, mutedAt: "2026-07-09T00:00:00Z", states: ["resurfaced"] }],
      },
    })
    const result = await createLatitudeReadClient(CONFIG).listSignals({})
    if (result.kind !== "ok") throw new Error("expected ok")
    expect(result.signals[0].muted).toBe(true)
    expect(result.signals[0].states).toEqual(["resurfaced"])
  })

  it("emits an empty deep link when no web base URL is configured", async () => {
    stubFetch({ json: { items: [RAW_SIGNAL] } })
    const client = createLatitudeReadClient({ ...CONFIG, webBaseUrl: undefined })
    const result = await client.listSignals({})
    if (result.kind !== "ok") throw new Error("expected ok")
    expect(result.signals[0].deepLinkUrl).toBe("")
  })
})

describe("createLatitudeReadClient.listSignals — never throws", () => {
  it("maps 401 and 403 to unauthorized", async () => {
    stubFetch({ status: 401 })
    expect((await createLatitudeReadClient(CONFIG).listSignals({})).kind).toBe("unauthorized")
    stubFetch({ status: 403 })
    expect((await createLatitudeReadClient(CONFIG).listSignals({})).kind).toBe("unauthorized")
  })

  it("maps 5xx to error with the status", async () => {
    stubFetch({ status: 503 })
    const result = await createLatitudeReadClient(CONFIG).listSignals({})
    expect(result).toEqual({ kind: "error", status: 503 })
  })

  it("maps a network failure and malformed JSON to error", async () => {
    stubFetch({ throwNetwork: true })
    expect((await createLatitudeReadClient(CONFIG).listSignals({})).kind).toBe("error")
    stubFetch({ status: 200, badJson: true })
    expect((await createLatitudeReadClient(CONFIG).listSignals({})).kind).toBe("error")
  })
})

describe("mapSignalsPage (pure)", () => {
  it("defaults every missing field safely and defaults hasMore/nextCursor", () => {
    const out = mapSignalsPage({ items: [{ id: "x" }] }, "http://w", "p")
    if (out.kind !== "ok") throw new Error("expected ok")
    const s = out.signals[0]
    expect(s.name).toBe("") // no name, no slug → ""
    expect(s.source).toBe("custom")
    expect(s.states).toEqual([])
    expect(s.occurrences).toBe(0)
    expect(s.trend).toEqual([])
    expect(out.nextCursor).toBeNull()
    expect(out.hasMore).toBe(false)
  })

  it("returns an empty page for a body without items", () => {
    const out = mapSignalsPage({}, undefined, "p")
    expect(out).toEqual({ kind: "ok", signals: [], nextCursor: null, hasMore: false })
  })
})
