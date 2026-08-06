/**
 * mapAnalyticsError — translates upstream Google Analytics (gaxios) errors into
 * `[ISSUE_CODE]`-prefixed Error messages. The mca-sdk only serializes
 * `error.message` to the model, so the bracketed code IS the actionable signal
 * the LLM parses to decide whether to retry, reconnect OAuth, or surface a
 * NOT_FOUND. These tests assert the EXACT thrown message (prefix + literal
 * upstream text), and that the function always throws (never returns).
 */

import { describe, expect, it } from "bun:test"
import { mapAnalyticsError } from "../../src/helpers"

/** Run mapAnalyticsError and return the thrown message; fail if it returns. */
function thrownMessage(err: unknown): string {
  try {
    mapAnalyticsError(err)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error("expected mapAnalyticsError to throw, but it returned normally")
}

describe("mapAnalyticsError — status → issue code (exact message)", () => {
  it("401 → AUTH_EXPIRED, preserving the literal upstream message", () => {
    expect(thrownMessage({ code: 401, message: "Invalid Credentials" })).toBe(
      "[AUTH_EXPIRED] Invalid Credentials",
    )
  })

  it("404 → NOT_FOUND", () => {
    expect(thrownMessage({ code: 404, message: "Property not found" })).toBe(
      "[NOT_FOUND] Property not found",
    )
  })

  it("429 → RATE_LIMITED", () => {
    expect(thrownMessage({ code: 429, message: "Too many requests" })).toBe(
      "[RATE_LIMITED] Too many requests",
    )
  })

  it("400 → INVALID_ARGUMENT", () => {
    expect(thrownMessage({ code: 400, message: "Invalid value for: metrics" })).toBe(
      "[INVALID_ARGUMENT] Invalid value for: metrics",
    )
  })

  it("500 → DEPENDENCY_UNAVAILABLE (boundary of the >=500 branch)", () => {
    expect(thrownMessage({ code: 500, message: "Internal error" })).toBe(
      "[DEPENDENCY_UNAVAILABLE] Internal error",
    )
  })

  it("503 → DEPENDENCY_UNAVAILABLE", () => {
    expect(thrownMessage({ code: 503, message: "Backend unavailable" })).toBe(
      "[DEPENDENCY_UNAVAILABLE] Backend unavailable",
    )
  })

  it("an unmapped 4xx (418) → UNKNOWN", () => {
    expect(thrownMessage({ code: 418, message: "teapot" })).toBe("[UNKNOWN] teapot")
  })
})

describe("mapAnalyticsError — 403 sub-classification by message", () => {
  it("403 + quota wording → RATE_LIMITED", () => {
    expect(
      thrownMessage({ code: 403, message: "Quota exceeded for metric X" }),
    ).toBe("[RATE_LIMITED] Quota exceeded for metric X")
  })

  it("403 + rate wording → RATE_LIMITED", () => {
    expect(thrownMessage({ code: 403, message: "User rate limit exceeded" })).toBe(
      "[RATE_LIMITED] User rate limit exceeded",
    )
  })

  it("403 + scope wording → INSUFFICIENT_SCOPE", () => {
    expect(
      thrownMessage({ code: 403, message: "Request had insufficient authentication scopes" }),
    ).toBe("[INSUFFICIENT_SCOPE] Request had insufficient authentication scopes")
  })

  it("403 + permission wording → INSUFFICIENT_SCOPE", () => {
    expect(
      thrownMessage({ code: 403, message: "The caller does not have permission" }),
    ).toBe("[INSUFFICIENT_SCOPE] The caller does not have permission")
  })

  it("403 with no special wording → FORBIDDEN", () => {
    expect(thrownMessage({ code: 403, message: "Forbidden" })).toBe(
      "[FORBIDDEN] Forbidden",
    )
  })

  it("403 quota wording wins over scope (quota|rate is checked first)", () => {
    // Message contains BOTH 'quota' and 'scope' — the quota branch must win.
    expect(
      thrownMessage({ code: 403, message: "Quota exceeded for this scope" }),
    ).toBe("[RATE_LIMITED] Quota exceeded for this scope")
  })
})

describe("mapAnalyticsError — code source & message precedence", () => {
  it("derives the code from response.status when err.code is absent", () => {
    expect(
      thrownMessage({
        response: { status: 404, data: { error: { message: "No such property" } } },
      }),
    ).toBe("[NOT_FOUND] No such property")
  })

  it("prefers err.message over the nested response error message", () => {
    expect(
      thrownMessage({
        code: 400,
        message: "top-level",
        response: { data: { error: { message: "nested" } } },
      }),
    ).toBe("[INVALID_ARGUMENT] top-level")
  })

  it("falls back to the nested response error message when no top-level message", () => {
    expect(
      thrownMessage({ code: 401, response: { data: { error: { message: "from nested" } } } }),
    ).toBe("[AUTH_EXPIRED] from nested")
  })

  it("falls back to a generic message when none is provided", () => {
    expect(thrownMessage({ code: 500 })).toBe(
      "[DEPENDENCY_UNAVAILABLE] Google Analytics API error",
    )
  })

  it("no recognizable code → UNKNOWN with the generic message", () => {
    expect(thrownMessage({ foo: "bar" })).toBe("[UNKNOWN] Google Analytics API error")
  })

  it("a null error throws UNKNOWN without crashing on property access", () => {
    expect(thrownMessage(null)).toBe("[UNKNOWN] Google Analytics API error")
  })
})

describe("mapAnalyticsError — robust status sourcing (gaxios shapes)", () => {
  it("reads the numeric status from err.status (modern gaxios)", () => {
    // gaxios ≥6 puts the HTTP status on `err.status`, not `err.code`.
    // The old `err.code ?? err.response?.status` lookup MISSED this → UNKNOWN.
    expect(thrownMessage({ status: 503, message: "Service Unavailable" })).toBe(
      "[DEPENDENCY_UNAVAILABLE] Service Unavailable",
    )
  })

  it("reads err.status for a 401 (AUTH_EXPIRED)", () => {
    expect(thrownMessage({ status: 401, message: "Invalid Credentials" })).toBe(
      "[AUTH_EXPIRED] Invalid Credentials",
    )
  })

  it("a STRING err.code does NOT shadow the numeric response.status", () => {
    // Modern gaxios sets err.code = 'ERR_BAD_REQUEST' (string) AND the real
    // status on response.status. The classifier must use the 400, not fall
    // through to the network branch.
    expect(
      thrownMessage({
        code: "ERR_BAD_REQUEST",
        response: { status: 400, data: { error: { message: "Field metrics is required" } } },
      }),
    ).toBe("[INVALID_ARGUMENT] Field metrics is required")
  })
})

describe("mapAnalyticsError — transport errors without an HTTP status", () => {
  // DNS/connection/timeout failures carry a STRING err.code and no status.
  // They are transient → DEPENDENCY_UNAVAILABLE (retryable), not UNKNOWN.
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
    it(`${code} → DEPENDENCY_UNAVAILABLE`, () => {
      expect(thrownMessage({ code, message: `network error: ${code}` })).toBe(
        `[DEPENDENCY_UNAVAILABLE] network error: ${code}`,
      )
    })
  }

  it("preserves the literal upstream message for a timeout", () => {
    expect(
      thrownMessage({ code: "ETIMEDOUT", message: "request to analyticsdata.googleapis.com timed out" }),
    ).toBe("[DEPENDENCY_UNAVAILABLE] request to analyticsdata.googleapis.com timed out")
  })
})
