/**
 * Mongo-backed rate limiter (FASE 5b): atomic fixed-window counter + HTTP edge
 * enforcement (path classification, scope order, short-circuit, fail-open).
 *
 * The counter uses a faithful InMemoryDb (findOneAndUpdate with $inc + upsert +
 * returnDocument:'after', the mongodb v6 shape). Asserts pin the EXACT decision
 * (allowed/remaining/retryAfter) and the persisted doc.
 *
 * MUST BITE (confirmed red against mutated source):
 *   - `count <= limit` → `<`: the limit-th hit wrongly denied,
 *   - dropping `Math.max(0, …)`: remaining goes negative on over-limit,
 *   - fail-open catch returning allowed:false: a Mongo blip walls everyone,
 *   - dropping the short-circuit in enforceHttpRateLimit: blocked request still
 *     consumes the per-IP budget,
 *   - widening isRateLimitedPath (excluding nothing): /static gets limited.
 */

import { describe, expect, it } from "bun:test"
import {
  enforceHttpRateLimit,
  type HttpRateLimitConfig,
  isAuthPath,
  isRateLimitedPath,
  RateLimiter,
} from "../../src/services/rate-limiter"
import { InMemoryDb } from "./_stripe-test-helpers"

const noopLog = {
  error() {},
  info() {},
  warn() {},
  debug() {},
  child() {
    return noopLog
  },
} as any

const RULE = { windowMs: 1000, limit: 2 }

describe("RateLimiter.consume", () => {
  it("allows up to the limit then denies, with exact remaining/retryAfter", async () => {
    const db = new InMemoryDb()
    const rl = new RateLimiter(db as any, noopLog)
    const now = 5000 // windowStart=5000, resetAt=6000

    expect(await rl.consume("ip", "1.1.1.1", RULE, now)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 1,
      limit: 2,
    })
    expect(await rl.consume("ip", "1.1.1.1", RULE, now)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 1,
      limit: 2,
    })
    expect(await rl.consume("ip", "1.1.1.1", RULE, now)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 1,
      limit: 2,
    })
  })

  it("keeps separate counters per (scope, key)", async () => {
    const db = new InMemoryDb()
    const rl = new RateLimiter(db as any, noopLog)
    await rl.consume("ip", "a", RULE, 5000)
    await rl.consume("ip", "a", RULE, 5000)
    // Different key → fresh budget.
    expect((await rl.consume("ip", "b", RULE, 5000)).allowed).toBe(true)
    // Different scope, same key → fresh budget.
    expect((await rl.consume("global", "a", RULE, 5000)).allowed).toBe(true)
  })

  it("resets when the window rolls over", async () => {
    const db = new InMemoryDb()
    const rl = new RateLimiter(db as any, noopLog)
    await rl.consume("ip", "x", RULE, 5000)
    await rl.consume("ip", "x", RULE, 5000)
    expect((await rl.consume("ip", "x", RULE, 5999)).allowed).toBe(false) // same window
    expect((await rl.consume("ip", "x", RULE, 6000)).allowed).toBe(true) // next window
  })

  it("computes retryAfter from the position within the window", async () => {
    const db = new InMemoryDb()
    const rl = new RateLimiter(db as any, noopLog)
    // now=5500 → resetAt=6000 → ceil((6000-5500)/1000)=1
    expect((await rl.consume("ip", "y", RULE, 5500)).retryAfterSeconds).toBe(1)
    // now=4001 → window 4000..5000 → ceil((5000-4001)/1000)=1
    expect((await rl.consume("ip", "z", RULE, 4001)).retryAfterSeconds).toBe(1)
  })

  it("persists a counter doc keyed by scope:key:windowStart with expiry", async () => {
    const db = new InMemoryDb()
    const rl = new RateLimiter(db as any, noopLog)
    await rl.consume("ip", "1.2.3.4", RULE, 5000)
    await rl.consume("ip", "1.2.3.4", RULE, 5400) // same window
    const docs = db.collection("rate_limit_counters").docs
    expect(docs).toHaveLength(1)
    expect(docs[0]._id).toBe("ip:1.2.3.4:5000")
    expect(docs[0].count).toBe(2)
    expect(docs[0].expiresAt).toEqual(new Date(6000))
  })

  it("fails OPEN when the counter store errors", async () => {
    const throwingDb = {
      collection() {
        return {
          findOneAndUpdate() {
            throw new Error("mongo down")
          },
        }
      },
    }
    const rl = new RateLimiter(throwingDb as any, noopLog)
    const decision = await rl.consume("ip", "1.1.1.1", RULE, 5000)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(2)
  })
})

describe("isRateLimitedPath", () => {
  it("excludes static/content and machine routes", () => {
    for (const p of [
      "/static/x.png",
      "/uploads/voice.webm",
      "/public/pcm.js",
      "/pcm-processor.js",
      "/media/abc",
      "/api/media/abc",
      "/api/files?id=1",
      "/webhooks/stripe",
      "/webhooks/github",
      "/api/event",
      "/api/mca-event",
      "/api/feedback/submit",
      "/health",
      "/metrics",
      "/",
    ]) {
      expect(isRateLimitedPath(p)).toBe(false)
    }
  })

  it("includes the user-facing API/auth surface", () => {
    for (const p of [
      "/auth/login",
      "/api/auth/google",
      "/api/upload/file",
      "/api/share",
      "/admin/users",
      "/g2/chat",
      "/api/tasks/123",
      "/api/providers/oauth/start",
    ]) {
      expect(isRateLimitedPath(p)).toBe(true)
    }
  })

  it("ignores the query string when classifying", () => {
    expect(isRateLimitedPath("/health?probe=1")).toBe(false)
    expect(isRateLimitedPath("/auth/login?next=/x")).toBe(true)
  })
})

describe("isAuthPath", () => {
  it("matches the auth surfaces only", () => {
    expect(isAuthPath("/auth/login")).toBe(true)
    expect(isAuthPath("/api/auth/google")).toBe(true)
    expect(isAuthPath("/admin/users")).toBe(false)
    expect(isAuthPath("/api/upload/x")).toBe(false)
  })
})

describe("enforceHttpRateLimit", () => {
  const CFG: HttpRateLimitConfig = {
    global: { windowMs: 1000, limit: 1000 },
    perIp: { windowMs: 1000, limit: 2 },
    auth: { windowMs: 1000, limit: 1 },
  }

  function limiter() {
    return new RateLimiter(new InMemoryDb() as any, noopLog)
  }

  it("returns null (allowed) for excluded paths without consuming budget", async () => {
    const rl = limiter()
    const db = (rl as any).col as any
    expect(await enforceHttpRateLimit(rl, CFG, "1.1.1.1", "/static/x.png", 5000)).toBeNull()
    expect(db.docs).toHaveLength(0)
  })

  it("allows under-limit API requests", async () => {
    const rl = limiter()
    expect(await enforceHttpRateLimit(rl, CFG, "1.1.1.1", "/admin/users", 5000)).toBeNull()
  })

  it("denies on the per-IP scope past its limit", async () => {
    const rl = limiter()
    await enforceHttpRateLimit(rl, CFG, "1.1.1.1", "/admin/users", 5000)
    await enforceHttpRateLimit(rl, CFG, "1.1.1.1", "/admin/users", 5000)
    const denied = await enforceHttpRateLimit(rl, CFG, "1.1.1.1", "/admin/users", 5000)
    expect(denied).not.toBeNull()
    expect(denied?.scope).toBe("ip")
    expect(denied?.retryAfterSeconds).toBe(1)
  })

  it("denies on the stricter auth scope (1/window) on /auth", async () => {
    const rl = limiter()
    expect(await enforceHttpRateLimit(rl, CFG, "2.2.2.2", "/auth/login", 5000)).toBeNull()
    const denied = await enforceHttpRateLimit(rl, CFG, "2.2.2.2", "/auth/login", 5000)
    expect(denied?.scope).toBe("auth")
  })

  it("short-circuits: a global denial does not consume the per-IP budget", async () => {
    const rl = limiter()
    const cfg: HttpRateLimitConfig = { ...CFG, global: { windowMs: 1000, limit: 0 } }
    const denied = await enforceHttpRateLimit(rl, cfg, "9.9.9.9", "/admin/users", 5000)
    expect(denied?.scope).toBe("global")
    const docs = (rl as any).col.docs as any[]
    // Only the global counter exists — the per-IP scope was never consumed.
    expect(docs.map((d) => d._id)).toEqual(["global:all:5000"])
  })
})
