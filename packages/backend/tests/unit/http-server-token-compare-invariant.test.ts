/**
 * Invariant — service-token comparisons on the HTTP routes stay timing-safe (SEC-6/M3).
 *
 * `/api/event`, `/api/mca-event`, and `/api/feedback/submit` authenticate with a
 * shared secret compared against a caller-supplied header. A plain `===`/`!==`
 * comparison leaks the token one byte at a time via response-time differences —
 * the exact class the audit flagged (M3), matching the pattern already fixed
 * elsewhere (`admin-routes.ts`, container/webhook handlers).
 *
 * `timingSafeStringEqual` (lib/http-security.ts) is behaviorally indistinguishable
 * from `===` for every functional test — a mutation swapping one for the other
 * produces identical pass/fail results, so no assertion on inputs/outputs can
 * catch a regression back to `===`. This test makes it structural instead:
 * grep every token-bearing branch in http-server.ts and fail if a direct
 * equality/inequality check on the secret reappears.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const HTTP_SERVER = resolve(__dirname, "../../src/bootstrap/http-server.ts")

function source(): string {
  return readFileSync(HTTP_SERVER, "utf-8")
}

describe("http-server token-compare invariant (SEC-6/M3)", () => {
  it("imports timingSafeStringEqual from the shared http-security helper", () => {
    expect(source()).toMatch(
      /import\s*\{[^}]*timingSafeStringEqual[^}]*\}\s*from\s*'\.\.\/lib\/http-security'/,
    )
  })

  it("the internal-token guard (/api/event, /api/mca-event) uses timingSafeStringEqual", () => {
    const matches = source().match(
      /timingSafeStringEqual\(authHeader, `Bearer \$\{mcaSecret\.internalToken\}`\)/g,
    )
    // Two call sites: handleEventRoute and handleMcaEventRoute.
    expect(matches?.length).toBe(2)
  })

  it("the feedback-token guard (/api/feedback/submit) uses timingSafeStringEqual", () => {
    expect(source()).toContain("timingSafeStringEqual(authHeader, feedbackSecret.apiToken)")
  })

  it("never compares mcaSecret.internalToken or feedbackSecret.apiToken with plain === / !==", () => {
    const src = source()
    // A direct comparison would read `authHeader !== \`Bearer ${mcaSecret.internalToken}\``
    // or `authHeader !== feedbackSecret.apiToken` (or the === form) OUTSIDE of a
    // timingSafeStringEqual(...) call. Strip every timingSafeStringEqual(...) call
    // first so its internal args don't trip the check, then look for a bare
    // comparison against either secret.
    const withoutTimingSafeCalls = src.replace(/timingSafeStringEqual\([^)]*\)/g, "")
    expect(withoutTimingSafeCalls).not.toMatch(/[!=]==\s*`Bearer \$\{mcaSecret\.internalToken\}`/)
    expect(withoutTimingSafeCalls).not.toMatch(/[!=]==\s*feedbackSecret\.apiToken/)
  })
})
