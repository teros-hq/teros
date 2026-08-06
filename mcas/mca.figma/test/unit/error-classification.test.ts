import { describe, expect, it } from "bun:test"
import { classifyFigmaError } from "../../src/lib/figma-error"

describe("classifyFigmaError", () => {
  it("401 → AUTH_EXPIRED with reconnect action, preserves upstream message", () => {
    const err = classifyFigmaError(401, '{"message":"Invalid token"}', "GET", "/files/abc")
    expect(err.code).toBe("AUTH_EXPIRED")
    expect(err.upstreamMessage).toBe("Invalid token") // literal upstream
    expect(err.message).toBe("[AUTH_EXPIRED] Invalid token") // SDK-visible
    expect(err.action.type).toBe("reconnect")
    expect(err.httpStatus).toBe(401)
  })

  it("403 → PERMISSION_DENIED references the endpoint in the action", () => {
    const err = classifyFigmaError(403, '{"message":"Forbidden"}', "POST", "/files/abc/comments")
    expect(err.code).toBe("PERMISSION_DENIED")
    expect(err.upstreamMessage).toBe("Forbidden")
    expect(err.message).toBe("[PERMISSION_DENIED] Forbidden")
    expect(err.action.description).toContain("POST /files/abc/comments")
  })

  it("404 → NOT_FOUND, action mentions the endpoint", () => {
    const err = classifyFigmaError(404, '{"message":"File not found"}', "GET", "/files/missing")
    expect(err.code).toBe("NOT_FOUND")
    expect(err.upstreamMessage).toBe("File not found")
    expect(err.message).toBe("[NOT_FOUND] File not found")
    expect(err.action.description).toContain("/files/missing")
  })

  it("400 → VALIDATION_FAILED, user_action", () => {
    const err = classifyFigmaError(400, '{"message":"Invalid node id"}', "GET", "/files/abc/nodes")
    expect(err.code).toBe("VALIDATION_FAILED")
    expect(err.action.type).toBe("user_action")
  })

  it("422 → VALIDATION_FAILED", () => {
    const err = classifyFigmaError(
      422,
      '{"message":"Unprocessable"}',
      "POST",
      "/files/abc/comments",
    )
    expect(err.code).toBe("VALIDATION_FAILED")
  })

  it("429 → RATE_LIMITED, auto_retry", () => {
    const err = classifyFigmaError(429, "Too Many Requests", "GET", "/files/abc")
    expect(err.code).toBe("RATE_LIMITED")
    expect(err.action.type).toBe("auto_retry")
  })

  it("5xx → DEPENDENCY_UNAVAILABLE", () => {
    for (const status of [500, 502, 503, 504]) {
      const err = classifyFigmaError(status, "Internal", "GET", "/files/abc")
      expect(err.code).toBe("DEPENDENCY_UNAVAILABLE")
      expect(err.action.type).toBe("auto_retry")
    }
  })

  it("unknown status → UNKNOWN with auto_retry", () => {
    const err = classifyFigmaError(418, "I'm a teapot", "GET", "/files/abc")
    expect(err.code).toBe("UNKNOWN")
    expect(err.upstreamMessage).toBe("I'm a teapot")
    expect(err.message).toBe("[UNKNOWN] I'm a teapot")
  })

  it("non-JSON body falls back to truncated upstream text", () => {
    const longBody = "x".repeat(500)
    const err = classifyFigmaError(500, longBody, "GET", "/files/abc")
    expect(err.upstreamMessage.length).toBeLessThanOrEqual(200)
  })

  it("empty body falls back to status string", () => {
    const err = classifyFigmaError(500, "", "GET", "/files/abc")
    expect(err.upstreamMessage).toContain("500")
    expect(err.message.startsWith("[DEPENDENCY_UNAVAILABLE]")).toBe(true)
  })
})
