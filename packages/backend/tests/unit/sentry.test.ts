/**
 * Sentry wrapper unit tests — @sentry/node is mocked, no real SDK init.
 *
 * Covers the wrapper contract (DSN gating, dev beforeSend filter, not-initialized
 * fallback, idempotent init) and the per-event context enrichment added for
 * TER-418: captureException(identity) forks a current scope, and
 * runWithRequestContext wraps work in an isolation scope. The fake models Sentry's
 * scope inheritance with a real AsyncLocalStorage so the concurrency test can prove
 * identity does NOT leak across concurrent async units of work (the security
 * property — a raw WS/HTTP server has no automatic request isolation).
 *
 *   bun test packages/backend/tests/unit/sentry.test.ts
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"

// --- Fake @sentry/node, faithful to the v8+ scope model -------------------------
// A scope holds user/tags/extras. withScope / withIsolationScope fork the active
// scope and run the callback inside it, propagating across awaits via ALS — exactly
// like the SDK. We don't distinguish current vs isolation scope because it isn't
// observable for what we assert; what matters is fork-vs-global (the leak we guard).

interface CapturedEvent {
  error: unknown
  extra: Record<string, unknown> | undefined
  user: { id: string } | null
  tags: Record<string, string>
}

class FakeScope {
  user: { id: string } | null = null
  tags: Record<string, string> = {}
  extras: Record<string, unknown> = {}
  setUser(u: { id: string } | null): this {
    this.user = u
    return this
  }
  setTag(k: string, v: string): this {
    this.tags[k] = v
    return this
  }
  setExtra(k: string, v: unknown): this {
    this.extras[k] = v
    return this
  }
  setContext(): this {
    return this
  }
  clone(): FakeScope {
    const c = new FakeScope()
    c.user = this.user
    c.tags = { ...this.tags }
    c.extras = { ...this.extras }
    return c
  }
}

const als = new AsyncLocalStorage<FakeScope>()
let baseScope: FakeScope
let captured: CapturedEvent[]
let initOptions: any

function activeScope(): FakeScope {
  return als.getStore() ?? baseScope
}

function fork<T>(cb: (scope: FakeScope) => T): T {
  const forked = activeScope().clone()
  return als.run(forked, () => cb(forked))
}

const sentryInit = mock((opts: any) => {
  initOptions = opts
})
const sentryCaptureException = mock(
  (error: unknown, hint?: { extra?: Record<string, unknown> }) => {
    const s = activeScope()
    captured.push({ error, extra: hint?.extra, user: s.user, tags: { ...s.tags } })
    return `evt_${captured.length}`
  },
)
const sentryWithScope = mock(fork)
const sentryWithIsolationScope = mock(fork)
// Module-level setters write to the ACTIVE scope (mirrors the SDK writing to the
// active isolation scope). Called OUTSIDE a fork → they hit baseScope → leak.
const sentrySetUser = mock((u: { id: string } | null) => {
  activeScope().setUser(u)
})
const sentrySetTag = mock((k: string, v: string) => {
  activeScope().setTag(k, v)
})

mock.module("@sentry/node", () => ({
  init: sentryInit,
  captureException: sentryCaptureException,
  captureMessage: mock(() => "msg_1"),
  withScope: sentryWithScope,
  withIsolationScope: sentryWithIsolationScope,
  setUser: sentrySetUser,
  setTag: sentrySetTag,
  setExtra: mock(() => {}),
  flush: mock(() => Promise.resolve(true)),
}))

// Dynamic import AFTER the mock is registered — a static import would be hoisted
// above mock.module and load the real @sentry/node (gotcha TER-459).
const sentry = await import("../../src/lib/sentry")

const origNodeEnv = process.env.NODE_ENV
const origDsn = process.env.SENTRY_DSN
const origDevEnabled = process.env.SENTRY_DEV_ENABLED

describe("sentry wrapper", () => {
  beforeEach(() => {
    baseScope = new FakeScope()
    captured = []
    sentryCaptureException.mockClear()
    sentryWithScope.mockClear()
    sentryWithIsolationScope.mockClear()
    sentrySetUser.mockClear()
    sentrySetTag.mockClear()
    delete process.env.SENTRY_DSN
    delete process.env.SENTRY_DEV_ENABLED
  })

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv
    if (origDsn === undefined) delete process.env.SENTRY_DSN
    else process.env.SENTRY_DSN = origDsn
    if (origDevEnabled === undefined) delete process.env.SENTRY_DEV_ENABLED
    else process.env.SENTRY_DEV_ENABLED = origDevEnabled
  })

  // ---- Virgin state: MUST run before any initSentry({ dsn }) in this file ------
  describe("uninitialized (runs first)", () => {
    it("captureException without init returns undefined and never touches the SDK", () => {
      expect(sentry.isInitialized()).toBe(false)
      const id = sentry.captureException(new Error("x"), { context: "c" }, { userId: "user_a" })
      expect(id).toBeUndefined()
      expect(sentryCaptureException).not.toHaveBeenCalled()
      expect(sentryWithScope).not.toHaveBeenCalled()
    })

    it("runWithRequestContext without init is a passthrough (runs fn, no isolation scope)", () => {
      let ran = false
      const out = sentry.runWithRequestContext({ userId: "user_a" }, () => {
        ran = true
        return 42
      })
      expect(ran).toBe(true)
      expect(out).toBe(42)
      expect(sentryWithIsolationScope).not.toHaveBeenCalled()
    })

    it("initSentry without a DSN does not initialize the SDK", () => {
      sentry.initSentry({})
      expect(sentry.isInitialized()).toBe(false)
      expect(sentryInit).not.toHaveBeenCalled()
    })
  })

  // ---- Initialized -------------------------------------------------------------
  describe("initialized", () => {
    beforeAll(() => {
      sentryInit.mockClear()
      sentry.initSentry({
        dsn: "https://abc@o1.ingest.sentry.io/1",
        environment: "production",
      })
    })

    it("initializes the SDK exactly once with the configured DSN", () => {
      expect(sentry.isInitialized()).toBe(true)
      expect(sentryInit).toHaveBeenCalledTimes(1)
      expect(sentryInit.mock.calls[0][0].dsn).toBe("https://abc@o1.ingest.sentry.io/1")
    })

    it("does not re-initialize on a second initSentry call (idempotent)", () => {
      sentryInit.mockClear()
      sentry.initSentry({ dsn: "https://abc@o1.ingest.sentry.io/1" })
      expect(sentryInit).not.toHaveBeenCalled()
    })

    describe("beforeSend dev filter", () => {
      it("drops events in development without SENTRY_DEV_ENABLED", () => {
        process.env.NODE_ENV = "development"
        delete process.env.SENTRY_DEV_ENABLED
        const event = { message: "boom" }
        expect(initOptions.beforeSend(event, {})).toBeNull()
      })

      it("keeps events in development when SENTRY_DEV_ENABLED is set", () => {
        process.env.NODE_ENV = "development"
        process.env.SENTRY_DEV_ENABLED = "1"
        const event = { message: "boom" }
        expect(initOptions.beforeSend(event, {})).toBe(event)
      })

      it("keeps events in production", () => {
        process.env.NODE_ENV = "production"
        const event = { message: "boom" }
        expect(initOptions.beforeSend(event, {})).toBe(event)
      })
    })

    describe("captureException", () => {
      it("without identity sends extra verbatim and does NOT fork a scope", () => {
        const err = new Error("boom")
        const id = sentry.captureException(err, { context: "svc", appId: "app_1" })
        expect(id).toBe("evt_1")
        expect(sentryWithScope).not.toHaveBeenCalled()
        expect(captured).toEqual([
          { error: err, extra: { context: "svc", appId: "app_1" }, user: null, tags: {} },
        ])
      })

      it("with identity applies user + tags on a forked scope (exact payload)", () => {
        const err = new Error("boom")
        const id = sentry.captureException(
          err,
          { context: "processVoiceContent", messageId: "msg_1" },
          {
            userId: "user_a",
            workspaceId: "work_1",
            agentId: "agent_1",
            channelId: "ch_1",
            mcaId: "mca.x",
            appId: "app_1",
          },
        )
        expect(id).toBe("evt_1")
        expect(sentryWithScope).toHaveBeenCalledTimes(1)
        expect(captured).toEqual([
          {
            error: err,
            extra: { context: "processVoiceContent", messageId: "msg_1" },
            user: { id: "user_a" },
            tags: {
              workspace_id: "work_1",
              agent_id: "agent_1",
              channel_id: "ch_1",
              mca_id: "mca.x",
              app_id: "app_1",
            },
          },
        ])
        // The base/global scope is never contaminated.
        expect(baseScope.user).toBeNull()
        expect(baseScope.tags).toEqual({})
      })

      it("skips undefined identity fields (no overwrite of inherited context)", () => {
        sentry.captureException(new Error("x"), undefined, {
          userId: undefined,
          channelId: "ch_1",
        })
        expect(captured[0].user).toBeNull()
        expect(captured[0].tags).toEqual({ channel_id: "ch_1" })
      })

      it("treats an empty identity object as no identity (no scope fork)", () => {
        const err = new Error("x")
        sentry.captureException(err, { context: "c" }, {})
        expect(sentryWithScope).not.toHaveBeenCalled()
        expect(captured).toEqual([{ error: err, extra: { context: "c" }, user: null, tags: {} }])
      })

      it("does not leak identity across sequential captures (per-event isolation)", () => {
        sentry.captureException(new Error("a"), undefined, { userId: "user_a" })
        sentry.captureException(new Error("b"), undefined, { userId: "user_b" })
        expect(captured.map((c) => c.user)).toEqual([{ id: "user_a" }, { id: "user_b" }])
        expect(baseScope.user).toBeNull()
      })
    })

    describe("runWithRequestContext", () => {
      it("applies identity to events captured inside and returns fn's value", async () => {
        const inside = new Error("inside")
        const result = await sentry.runWithRequestContext(
          { userId: "user_a", workspaceId: "work_1" },
          async () => {
            sentry.captureException(inside)
            return "done"
          },
        )
        expect(result).toBe("done")
        expect(sentryWithIsolationScope).toHaveBeenCalledTimes(1)
        expect(captured).toEqual([
          { error: inside, extra: undefined, user: { id: "user_a" }, tags: { workspace_id: "work_1" } },
        ])
        // Context must NOT survive outside the callback.
        sentry.captureException(new Error("outside"))
        expect(captured[1].user).toBeNull()
        expect(captured[1].tags).toEqual({})
      })

      it("isolates identity across CONCURRENT async units of work (no global bleed)", async () => {
        // Each unit yields between setting context and capturing. With a global
        // setUser (the bug) both would read the last writer. With a per-unit
        // isolation scope, each reads its own.
        const work = (userId: string, label: string) =>
          sentry.runWithRequestContext({ userId }, async () => {
            await Promise.resolve()
            await Promise.resolve()
            sentry.captureException(new Error(label))
          })

        await Promise.all([work("user_a", "a"), work("user_b", "b")])

        const byError = Object.fromEntries(
          captured.map((c) => [(c.error as Error).message, c.user?.id]),
        )
        expect(byError).toEqual({ a: "user_a", b: "user_b" })
        expect(baseScope.user).toBeNull()
      })
    })
  })
})
