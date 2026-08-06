/**
 * Tests for populateRateLimitContext (TER-512).
 *
 * The frontend RateLimitWidget reads context.{isRateLimit, retryAfterSecs,
 * retryAfterMs, resetAt, source} to render a countdown. OpenAI/OpenRouter
 * surface 429 headers as a NATIVE `Headers` instance (fetch-based SDK), where
 * bracket access `headers["retry-after"]` returns undefined. The regression
 * test below pins that the helper reads the header via `.get()` so the widget
 * actually appears.
 */

import { describe, expect, it } from "bun:test"
import { populateRateLimitContext } from "./rate-limit-context"

describe("populateRateLimitContext", () => {
  it("reads retry-after from a native Headers instance (the gotcha)", () => {
    const before = Date.now()
    const ctx = populateRateLimitContext(new Headers({ "retry-after": "120" }), "OpenAI")

    expect(ctx.isRateLimit).toBe(true)
    expect(ctx.retryAfterSecs).toBe(120)
    expect(ctx.retryAfterMs).toBe(120000)
    expect(ctx.source).toBe("OpenAI")
    // resetAt is Date.now()-dependent: assert it is a number in the expected window.
    expect(typeof ctx.resetAt).toBe("number")
    expect(ctx.resetAt).toBeGreaterThan(before)
    expect(ctx.resetAt as number).toBeGreaterThanOrEqual(before + 120000)
  })

  it("REGRESSION: native Headers must NOT yield undefined retryAfterSecs (bracket-access bug)", () => {
    // A buggy implementation using `headers["retry-after"]` would read undefined
    // off a native Headers instance. This pins the correct .get()-based read.
    const headers = new Headers({ "retry-after": "120" })
    expect((headers as unknown as Record<string, unknown>)["retry-after"]).toBeUndefined()

    const ctx = populateRateLimitContext(headers, "OpenRouter")
    expect(ctx.retryAfterSecs).toBe(120)
    expect(ctx.source).toBe("OpenRouter")
  })

  it("reads retry-after from a legacy plain object (fallback)", () => {
    const ctx = populateRateLimitContext({ "retry-after": "90" }, "OpenAI")

    expect(ctx.isRateLimit).toBe(true)
    expect(ctx.retryAfterSecs).toBe(90)
    expect(ctx.retryAfterMs).toBe(90000)
    expect(typeof ctx.resetAt).toBe("number")
  })

  it("flags isRateLimit even when no retry-after header is present", () => {
    const ctx = populateRateLimitContext(new Headers(), "OpenAI")

    expect(ctx.isRateLimit).toBe(true)
    expect(ctx.retryAfterSecs).toBeUndefined()
    expect(ctx.retryAfterMs).toBeUndefined()
    expect(ctx.resetAt).toBeUndefined()
    expect(ctx.source).toBe("OpenAI")
  })

  it("treats an HTTP-date retry-after as undefined (NaN guard)", () => {
    const ctx = populateRateLimitContext(
      new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      "OpenRouter",
    )

    expect(ctx.isRateLimit).toBe(true)
    expect(ctx.retryAfterSecs).toBeUndefined()
    expect(ctx.retryAfterMs).toBeUndefined()
    expect(ctx.resetAt).toBeUndefined()
  })

  it("handles undefined/null headers without throwing", () => {
    const ctx = populateRateLimitContext(undefined, "OpenAI")

    expect(ctx.isRateLimit).toBe(true)
    expect(ctx.retryAfterSecs).toBeUndefined()
    expect(ctx.source).toBe("OpenAI")
  })
})
