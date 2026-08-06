/**
 * Unit tests for the Latitude score emitter (F4 · C0).
 *
 * Mutation-verified: each assertion pins the EXACT payload / call count, not
 * "was called". The fake ScoreClient mirrors the REST contract verified against
 * the Latitude source (`apps/api/src/routes/scores.ts`): a custom score is
 * `{ value, passed, feedback, sourceId, trace:{by:"id",id}, metadata }`; the
 * endpoint answers a not-yet-flushed `trace.by:"id"` lookup with 404 "Trace not
 * found" (verified against the live REST API), the case C0 must retry.
 */

import { afterEach, describe, expect, it } from "bun:test"
import {
  createLatitudeScoreClient,
  LatitudeScoreEmitter,
  type ScoreClient,
  type ScoreSubmitPayload,
  type ScoreSubmitResult,
} from "../../src/services/latitude-score-emitter"
import { traceIdFor } from "../../src/services/otel-span-builder"

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

const instantSleep = () => Promise.resolve()

interface FakeSession {
  sessionUsageId: string
  rootSessionUsageId?: string
  provider: string
  actualProvider?: string | null
  workspaceId: string
  agentId: string
  toolErrorCount?: number
}

const baseSession: FakeSession = {
  sessionUsageId: "usess_child",
  rootSessionUsageId: "usess_root",
  provider: "anthropic", // retains → not ZDR-gated
  actualProvider: "anthropic",
  workspaceId: "work_1",
  agentId: "agent_1",
  toolErrorCount: 2,
}

/** DB fake: `agent_usage_sessions` returns `session`; `llm_usage` maps messageId→sessionUsageId. */
function fakeDb(session: FakeSession | null, opts: { llmUsageSessionId?: string | null } = {}) {
  return {
    collection: (name: string) => ({
      findOne: async () => {
        if (name === "agent_usage_sessions") return session
        if (name === "llm_usage") {
          if (opts.llmUsageSessionId === null) return null
          return { sessionUsageId: opts.llmUsageSessionId ?? session?.sessionUsageId }
        }
        return null
      },
    }),
  } as any
}

/** Records every submitted payload; returns the queued results in order. */
function recordingClient(results: ScoreSubmitResult[]): {
  client: ScoreClient
  payloads: ScoreSubmitPayload[]
} {
  const payloads: ScoreSubmitPayload[] = []
  let i = 0
  return {
    payloads,
    client: {
      async submit(payload) {
        payloads.push(payload)
        return results[Math.min(i++, results.length - 1)] ?? { kind: "ok" }
      },
    },
  }
}

function makeMetrics() {
  const calls = {
    emitted: [] as string[],
    delivered: 0,
    dropped: [] as string[],
    retries: 0,
  }
  const metrics = {
    recordEmitted: (r: string) => calls.emitted.push(r),
    recordDelivered: () => {
      calls.delivered++
    },
    recordDropped: (c: string) => calls.dropped.push(c),
    recordTraceNotFoundRetry: () => {
      calls.retries++
    },
    setInFlight: () => {},
  } as any
  return { metrics, calls }
}

/** Let the detached fire-and-forget chain settle (sleeps are instant in tests). */
const settle = () => new Promise((r) => setTimeout(r, 20))

describe("LatitudeScoreEmitter — categorical payload (no content)", () => {
  it("👎 emits the exact thumbs_down custom-score body pinned to traceIdFor(root)", async () => {
    const { client, payloads } = recordingClient([{ kind: "ok" }])
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
    })

    emitter.emitMessageFeedback({ messageId: "msg_9", rating: "down" })
    await settle()

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toEqual({
      value: 0,
      passed: false,
      feedback: "thumbs_down",
      sourceId: "teros-runtime",
      trace: { by: "id", id: traceIdFor("usess_root") },
      metadata: {
        reason: "thumbs_down",
        session_id: "usess_child",
        root_session_id: "usess_root",
        workspace_id: "work_1",
        agent_id: "agent_1",
        provider: "anthropic",
        actual_provider: "anthropic",
      },
    })
  })

  it("the payload never carries user content (comment/reasons/text)", async () => {
    const { client, payloads } = recordingClient([{ kind: "ok" }])
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
    })
    emitter.emitMessageFeedback({ messageId: "msg_9", rating: "down" })
    await settle()
    const serialized = JSON.stringify(payloads[0])
    // Only ids + the categorical token — every value is an enum/id.
    expect(serialized.includes("comment")).toBe(false)
    expect(serialized.includes("reasons")).toBe(false)
    expect(payloads[0]?.feedback).toBe("thumbs_down")
  })

  it("👍 is a no-op (only failures grow signals)", async () => {
    const { client, payloads } = recordingClient([{ kind: "ok" }])
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
    })
    emitter.emitMessageFeedback({ messageId: "msg_9", rating: "up" })
    await settle()
    expect(payloads).toHaveLength(0)
  })

  it("tool_error score fires only when toolErrorCount > 0", async () => {
    const withErrors = recordingClient([{ kind: "ok" }])
    const e1 = new LatitudeScoreEmitter({
      db: fakeDb({ ...baseSession, toolErrorCount: 2 }),
      client: withErrors.client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
    })
    e1.emitSessionFailure({ sessionUsageId: "usess_child" })
    await settle()
    expect(withErrors.payloads).toHaveLength(1)
    expect(withErrors.payloads[0]?.feedback).toBe("tool_error")

    const noErrors = recordingClient([{ kind: "ok" }])
    const e2 = new LatitudeScoreEmitter({
      db: fakeDb({ ...baseSession, toolErrorCount: 0 }),
      client: noErrors.client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
    })
    e2.emitSessionFailure({ sessionUsageId: "usess_child" })
    await settle()
    expect(noErrors.payloads).toHaveLength(0)
  })
})

describe("LatitudeScoreEmitter — no ZDR gate (categorical scores are content-free)", () => {
  // Every provider is scored, INCLUDING the ZDR default `teros`/`fireworks`: a
  // categorical failure token + ids carries no content, exactly like F3a's
  // structure-only trace export (also not ZDR-gated). Text — and its per-call ZDR
  // guard — stays behind F3b. Withholding the score for a ZDR turn would orphan
  // the trace F3a still exported.
  const cases: Array<{ provider: string; actualProvider: string | null }> = [
    { provider: "teros", actualProvider: "fireworks" }, // default alias, both ZDR → still emits
    { provider: "fireworks", actualProvider: null },
    { provider: "anthropic", actualProvider: "fireworks" },
    { provider: "anthropic", actualProvider: "anthropic" },
    { provider: "minimax", actualProvider: null },
    { provider: "openai", actualProvider: null },
  ]

  for (const c of cases) {
    it(`${c.provider}/${c.actualProvider ?? "—"} → emitted with provider metadata`, async () => {
      const { client, payloads } = recordingClient([{ kind: "ok" }])
      const { metrics, calls } = makeMetrics()
      const emitter = new LatitudeScoreEmitter({
        db: fakeDb({ ...baseSession, provider: c.provider, actualProvider: c.actualProvider }),
        client,
        isEnabled: () => true,
        log: stubLogger,
        sleep: instantSleep,
        metrics,
      })
      emitter.emitSessionFailure({ sessionUsageId: "usess_child" })
      await settle()

      expect(payloads).toHaveLength(1)
      expect(calls.emitted).toEqual(["tool_error"])
      // Provider travels in metadata (an enum, not content) so signals slice by it.
      expect(payloads[0].metadata.provider).toBe(c.provider)
      expect(payloads[0].metadata.actual_provider).toBe(c.actualProvider ?? c.provider)
    })
  }
})

describe("LatitudeScoreEmitter — deferred retry", () => {
  it("retries on trace_not_found, then delivers", async () => {
    const { client, payloads } = recordingClient([{ kind: "trace_not_found" }, { kind: "ok" }])
    const { metrics, calls } = makeMetrics()
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
      metrics,
    })
    emitter.emitSessionFailure({ sessionUsageId: "usess_child" })
    await settle()

    expect(payloads).toHaveLength(2) // first miss + retry
    expect(calls.retries).toBe(1)
    expect(calls.delivered).toBe(1)
    expect(calls.dropped).toEqual([])
  })

  it("drops after retries are exhausted (still trace_not_found)", async () => {
    const { client, payloads } = recordingClient([{ kind: "trace_not_found" }])
    const { metrics, calls } = makeMetrics()
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
      maxRetries: 2,
      metrics,
    })
    emitter.emitSessionFailure({ sessionUsageId: "usess_child" })
    await settle()

    expect(payloads).toHaveLength(3) // attempts = maxRetries + 1
    expect(calls.retries).toBe(2)
    expect(calls.delivered).toBe(0)
    expect(calls.dropped).toEqual(["trace_not_found"])
  })

  it("backs off then delivers on rate_limited, honoring retryAfterMs (clamped)", async () => {
    const slept: number[] = []
    const { client, payloads } = recordingClient([
      { kind: "rate_limited", retryAfterMs: 999_999 },
      { kind: "ok" },
    ])
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: async (ms) => {
        slept.push(ms)
      },
      initialDelayMs: 7000,
      metrics: makeMetrics().metrics,
    })
    emitter.emitSessionFailure({ sessionUsageId: "usess_child" })
    await settle()

    expect(payloads).toHaveLength(2)
    expect(slept[0]).toBe(7000) // initial flush wait
    expect(slept[1]).toBe(30_000) // retry-after clamped to the 30s cap
  })

  it("does NOT retry a genuine error (uncertain → drop, POST not blindly retried)", async () => {
    const { client, payloads } = recordingClient([{ kind: "error", status: 500 }])
    const { metrics, calls } = makeMetrics()
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
      metrics,
    })
    emitter.emitSessionFailure({ sessionUsageId: "usess_child" })
    await settle()

    expect(payloads).toHaveLength(1) // one attempt, no retry
    expect(calls.dropped).toEqual(["error"])
  })
})

describe("LatitudeScoreEmitter — seam safety", () => {
  it("drops (does not enqueue) once the concurrency cap is reached", async () => {
    const { metrics, calls } = makeMetrics()
    // First chain parks forever in resolve(); cap=1 → the second emit is dropped.
    const hangingDb = {
      collection: () => ({ findOne: () => new Promise(() => {}) }),
    } as any
    const emitter = new LatitudeScoreEmitter({
      db: hangingDb,
      client: recordingClient([{ kind: "ok" }]).client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
      maxConcurrency: 1,
      metrics,
    })
    emitter.emitSessionFailure({ sessionUsageId: "a" }) // occupies the only slot
    emitter.emitSessionFailure({ sessionUsageId: "b" }) // dropped by the cap
    await settle()
    expect(calls.dropped).toEqual(["cap"])
  })

  it("no session → no submit", async () => {
    const { client, payloads } = recordingClient([{ kind: "ok" }])
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(null),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
    })
    emitter.emitSessionFailure({ sessionUsageId: "missing" })
    await settle()
    expect(payloads).toHaveLength(0)
  })

  it("👎 on a message with no instrumented turn (no sessionUsageId) → no submit", async () => {
    const { client, payloads } = recordingClient([{ kind: "ok" }])
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb(baseSession, { llmUsageSessionId: null }),
      client,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
    })
    emitter.emitMessageFeedback({ messageId: "msg_orphan", rating: "down" })
    await settle()
    expect(payloads).toHaveLength(0)
  })
})

describe("createLatitudeScoreClient — transport contract (faithful to Latitude REST)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const payload: ScoreSubmitPayload = {
    value: 0,
    passed: false,
    feedback: "tool_error",
    sourceId: "teros-runtime",
    trace: { by: "id", id: "1".repeat(32) },
    metadata: { reason: "tool_error" },
  }

  it("POSTs to /v1/projects/{slug}/scores with Bearer auth + JSON body", async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify({ source: "custom" }), { status: 201 })
    }) as any

    const client = createLatitudeScoreClient({
      apiBaseUrl: "http://localhost:3011/",
      token: "lat_seed_default_api_key_token",
      project: "default-project",
    })
    const result = await client.submit(payload)

    expect(result).toEqual({ kind: "ok" })
    expect(captured!.url).toBe("http://localhost:3011/v1/projects/default-project/scores")
    expect(captured!.init.method).toBe("POST")
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer lat_seed_default_api_key_token",
    )
    expect(JSON.parse(captured!.init.body as string)).toEqual(payload)
  })

  // The `trace.by:"id"` lookup C0 uses answers a not-yet-flushed trace with
  // HTTP 404 {"error":"Trace not found"} (verified against the live Latitude REST
  // API). This is the COMMON transient case (BatchSpanProcessor ~5s delay +
  // async ClickHouse ingest) and MUST be retriable — else the score is dropped.
  it("maps 404 'Trace not found' → trace_not_found (retriable — the live by-id path)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Trace not found" }), { status: 404 })) as any
    const client = createLatitudeScoreClient({ apiBaseUrl: "http://x", token: "t", project: "p" })
    expect(await client.submit(payload)).toEqual({ kind: "trace_not_found" })
  })

  it("maps a different 404 → error (NOT retriable)", async () => {
    globalThis.fetch = (async () => new Response("Not found", { status: 404 })) as any
    const client = createLatitudeScoreClient({ apiBaseUrl: "http://x", token: "t", project: "p" })
    expect(await client.submit(payload)).toEqual({ kind: "error", status: 404 })
  })

  // The filter/session-resolution path answers with 400 "Trace not found for
  // score"; kept retriable for robustness across Latitude versions.
  it("maps 400 'Trace not found' → trace_not_found (retriable)", async () => {
    globalThis.fetch = (async () =>
      new Response("Trace not found for score", { status: 400 })) as any
    const client = createLatitudeScoreClient({ apiBaseUrl: "http://x", token: "t", project: "p" })
    expect(await client.submit(payload)).toEqual({ kind: "trace_not_found" })
  })

  it("maps a different 400 → error (NOT retriable)", async () => {
    globalThis.fetch = (async () => new Response("Invalid payload", { status: 400 })) as any
    const client = createLatitudeScoreClient({ apiBaseUrl: "http://x", token: "t", project: "p" })
    expect(await client.submit(payload)).toEqual({ kind: "error", status: 400 })
  })

  it("maps 429 → rate_limited and parses Retry-After seconds", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 429, headers: { "retry-after": "3" } })) as any
    const client = createLatitudeScoreClient({ apiBaseUrl: "http://x", token: "t", project: "p" })
    expect(await client.submit(payload)).toEqual({ kind: "rate_limited", retryAfterMs: 3000 })
  })

  it("maps 5xx → error", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 502 })) as any
    const client = createLatitudeScoreClient({ apiBaseUrl: "http://x", token: "t", project: "p" })
    expect(await client.submit(payload)).toEqual({ kind: "error", status: 502 })
  })

  it("maps a thrown fetch (network/timeout) → error, never rejects", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as any
    const client = createLatitudeScoreClient({ apiBaseUrl: "http://x", token: "t", project: "p" })
    expect(await client.submit(payload)).toEqual({ kind: "error" })
  })
})
