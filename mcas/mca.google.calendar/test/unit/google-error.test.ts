/**
 * classifyGoogleApiError — translation of upstream Google API errors into
 * structured issues. Critical: `message` always carries the literal upstream
 * `message`, never an invented one.
 *
 * Regression case: 403 with reason `accessNotConfigured` (Calendar API not
 * enabled in the GCP project) used to be misclassified as AUTH_EXPIRED and
 * routed to user_action "Reconnect your Google account" — a user spent 4
 * reconnects on this before we found the real cause. Tests guard the fix.
 */

import { describe, expect, it } from "bun:test"
import { classifyGoogleApiError } from "../../src/tools/_google-error"

describe("classifyGoogleApiError", () => {
  it("403 accessNotConfigured -> DEPENDENCY_UNAVAILABLE + admin_action with literal message", () => {
    const err = {
      code: 403,
      message:
        "Google Calendar API has not been used in project 576688628020 before or it is disabled. Enable it by visiting...",
      errors: [{ reason: "accessNotConfigured", message: "Access Not Configured." }],
    }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue.action.type).toBe("admin_action")
    expect(issue.action.url).toContain("console.cloud.google.com")
    // Literal upstream message preserved.
    expect(issue.message).toContain("project 576688628020")
    expect(issue.message).toContain("disabled")
  })

  it("403 insufficientPermissions -> AUTH_INVALID + user_action (revoke + reconnect)", () => {
    const err = {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      errors: [{ reason: "insufficientPermissions" }],
    }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("AUTH_INVALID")
    expect(issue.action.type).toBe("user_action")
    expect(issue.action.description).toContain("revoke")
    expect(issue.message).toBe("Request had insufficient authentication scopes.")
  })

  it("403 quotaExceeded -> QUOTA_EXCEEDED + auto_retry", () => {
    const err = {
      code: 403,
      message: "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per day'.",
      errors: [{ reason: "quotaExceeded" }],
    }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("QUOTA_EXCEEDED")
    expect(issue.action.type).toBe("auto_retry")
    expect(issue.message).toContain("Quota exceeded")
  })

  it("403 billingNotEnabled -> DEPENDENCY_UNAVAILABLE + admin_action", () => {
    const err = {
      code: 403,
      message: "Billing has not been enabled for this project.",
      errors: [{ reason: "billingNotEnabled" }],
    }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue.action.type).toBe("admin_action")
    expect(issue.action.url).toContain("billing")
  })

  it("401 -> AUTH_EXPIRED + user_action (reconnect)", () => {
    const err = { code: 401, message: "Invalid Credentials" }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("AUTH_EXPIRED")
    expect(issue.action.type).toBe("user_action")
    expect(issue.message).toBe("Invalid Credentials")
  })

  it("429 rateLimitExceeded -> RATE_LIMITED + auto_retry", () => {
    const err = {
      code: 429,
      message: "User rate limit exceeded.",
      errors: [{ reason: "rateLimitExceeded" }],
    }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("RATE_LIMITED")
    expect(issue.action.type).toBe("auto_retry")
  })

  it("400 -> INTERNAL_ERROR + auto_retry (bad args)", () => {
    const err = { code: 400, message: "Invalid value for: timeMin." }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("INTERNAL_ERROR")
    expect(issue.message).toBe("Invalid value for: timeMin.")
  })

  it("503 -> DEPENDENCY_UNAVAILABLE + auto_retry", () => {
    const err = { code: 503, message: "Backend temporarily unavailable." }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue.action.type).toBe("auto_retry")
  })

  it("string code is normalised", () => {
    const err = { code: "401", message: "x" }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("AUTH_EXPIRED")
  })

  it("nested response.data.error shape (gaxios) is supported", () => {
    const err = {
      code: 403,
      response: {
        data: {
          error: {
            code: 403,
            message: "Calendar API not enabled",
            errors: [{ reason: "accessNotConfigured" }],
          },
        },
      },
    }
    const issue = classifyGoogleApiError(err)
    expect(issue.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue.action.type).toBe("admin_action")
    expect(issue.message).toBe("Calendar API not enabled")
  })

  it("unknown shape falls back without crashing", () => {
    const issue = classifyGoogleApiError({}, "Google Calendar")
    expect(issue.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue.message).toContain("Google Calendar")
  })

  it("null/undefined err falls back without crashing", () => {
    const issue = classifyGoogleApiError(null)
    expect(issue.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue.message).toBeTruthy()
  })
})
