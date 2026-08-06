/**
 * classifyAccountsProbe — the pure decision behind the health-check's Admin
 * API probe. Extracted so the two fixes that previously lived in the untested
 * handler (TER-369) are now pinned:
 *
 *  1. USER_CONFIG_MISSING when OAuth works but 0 GA accounts are visible
 *     (boundary: `accountCount === 0`, healthy at ≥1).
 *  2. A quota/rate 403 maps to RATE_LIMITED (auto_retry), NOT AUTH_EXPIRED —
 *     flattening it would tell the user to reconnect over a transient quota
 *     cap, burning a reconnect (the TER-222 failure mode).
 */

import { describe, expect, it } from "bun:test"
import { classifyAccountsProbe } from "../../src/helpers"

describe("classifyAccountsProbe — account count", () => {
  it("0 accounts → USER_CONFIG_MISSING (user_action)", () => {
    const issue = classifyAccountsProbe({ accountCount: 0 })
    expect(issue?.code).toBe("USER_CONFIG_MISSING")
    expect(issue?.action.type).toBe("user_action")
  })

  it("exactly 1 account → healthy (null) — the ≥1 boundary", () => {
    expect(classifyAccountsProbe({ accountCount: 1 })).toBeNull()
  })

  it("many accounts → healthy (null)", () => {
    expect(classifyAccountsProbe({ accountCount: 5 })).toBeNull()
  })
})

describe("classifyAccountsProbe — error classification", () => {
  it("403 + quota wording → RATE_LIMITED (auto_retry), NOT AUTH_EXPIRED", () => {
    const issue = classifyAccountsProbe({
      error: { status: 403, message: "Quota exceeded for quota metric 'Core Tokens'" },
    })
    expect(issue?.code).toBe("RATE_LIMITED")
    expect(issue?.action.type).toBe("auto_retry")
  })

  it("403 + rate wording → RATE_LIMITED", () => {
    expect(
      classifyAccountsProbe({ error: { status: 403, message: "User rate limit exceeded" } })?.code,
    ).toBe("RATE_LIMITED")
  })

  it("403 + permission/scope wording → AUTH_EXPIRED (reconnect)", () => {
    const issue = classifyAccountsProbe({
      error: { status: 403, message: "The caller does not have permission" },
    })
    expect(issue?.code).toBe("AUTH_EXPIRED")
    expect(issue?.action.type).toBe("user_action")
  })

  it("401 → AUTH_EXPIRED", () => {
    expect(classifyAccountsProbe({ error: { status: 401 } })?.code).toBe("AUTH_EXPIRED")
  })

  it("reads the status from a modern gaxios shape (string code + response.status)", () => {
    const issue = classifyAccountsProbe({
      error: { code: "ERR_BAD_REQUEST", response: { status: 401 } },
    })
    expect(issue?.code).toBe("AUTH_EXPIRED")
  })

  it("a transport error (string code, no status) → DEPENDENCY_UNAVAILABLE", () => {
    const issue = classifyAccountsProbe({ error: { code: "ENOTFOUND", message: "dns failure" } })
    expect(issue?.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue?.action.type).toBe("auto_retry")
  })

  it("a 500 → DEPENDENCY_UNAVAILABLE, embedding the upstream message", () => {
    const issue = classifyAccountsProbe({ error: { status: 500, message: "Internal error" } })
    expect(issue?.code).toBe("DEPENDENCY_UNAVAILABLE")
    expect(issue?.message).toContain("Internal error")
  })
})
