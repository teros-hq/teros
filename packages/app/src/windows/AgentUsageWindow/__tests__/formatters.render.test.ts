/**
 * Characterization tests for the agent usage dashboard formatters.
 *
 * These tests freeze the CURRENT behavior of the formatters extracted from
 * `AgentUsageWindowContent.tsx`. They are not aspirational — they document
 * what the dashboard already does. Any refactor that changes the output
 * here will fail the suite and is a behavioral change, not a refactor.
 *
 * Specifically validated:
 *   - boundary values (0, magnitude transitions, negative numbers).
 *   - non-finite inputs (NaN, Infinity, -Infinity, null where supported).
 *   - the em-dash `'—'` convention for missing data.
 *
 * `relativeTimeFromMs` depends on `Date.now()`; tests freeze a reference
 * point with a fake Date.now so the delta math is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  formatBytes,
  formatCost,
  formatDuration,
  formatHours,
  formatNumber,
  relativeTime,
  relativeTimeFromMs,
  resolveName,
} from "../formatters"

// =============================================================================
// formatNumber
// =============================================================================

describe("formatNumber", () => {
  it("non-finite inputs return em dash", () => {
    expect(formatNumber(Number.NaN)).toBe("—")
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("—")
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("—")
  })

  it("rounds integers <1000 without suffix", () => {
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(1)).toBe("1")
    expect(formatNumber(42)).toBe("42")
    expect(formatNumber(999)).toBe("999")
    expect(formatNumber(999.4)).toBe("999")
    expect(formatNumber(999.5)).toBe("1000")
  })

  it("formats values in [1_000, 1_000_000) with k suffix and 1 decimal", () => {
    expect(formatNumber(1_000)).toBe("1.0k")
    expect(formatNumber(1_500)).toBe("1.5k")
    expect(formatNumber(12_345)).toBe("12.3k")
    expect(formatNumber(999_999)).toBe("1000.0k")
  })

  it("formats values >=1_000_000 with M suffix and 2 decimals", () => {
    expect(formatNumber(1_000_000)).toBe("1.00M")
    expect(formatNumber(1_500_000)).toBe("1.50M")
    expect(formatNumber(12_345_678)).toBe("12.35M")
  })

  it("handles negative magnitudes via absolute-value threshold", () => {
    expect(formatNumber(-500)).toBe("-500")
    expect(formatNumber(-1_500)).toBe("-1.5k")
    expect(formatNumber(-2_000_000)).toBe("-2.00M")
  })
})

// =============================================================================
// formatCost
// =============================================================================

describe("formatCost", () => {
  it("non-finite returns em dash", () => {
    expect(formatCost(Number.NaN)).toBe("—")
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("—")
  })

  it("zero shows $0 (not $0.00)", () => {
    expect(formatCost(0)).toBe("$0")
  })

  it("sub-cent shows <$0.01 sentinel", () => {
    expect(formatCost(0.001)).toBe("<$0.01")
    expect(formatCost(0.0099)).toBe("<$0.01")
  })

  it("between cent and dollar shows 3 decimals", () => {
    expect(formatCost(0.01)).toBe("$0.010")
    expect(formatCost(0.123)).toBe("$0.123")
    expect(formatCost(0.999)).toBe("$0.999")
  })

  it("between $1 and $100 shows 2 decimals", () => {
    expect(formatCost(1)).toBe("$1.00")
    expect(formatCost(42.5)).toBe("$42.50")
    expect(formatCost(99.99)).toBe("$99.99")
  })

  it(">=$100 shows whole dollars with thousand separators (en-US)", () => {
    expect(formatCost(100)).toBe("$100")
    expect(formatCost(1234)).toBe("$1,234")
    expect(formatCost(1_234_567.89)).toBe("$1,234,568")
  })
})

// =============================================================================
// formatHours
// =============================================================================

describe("formatHours", () => {
  it("non-finite returns em dash", () => {
    expect(formatHours(Number.NaN)).toBe("—")
    expect(formatHours(Number.POSITIVE_INFINITY)).toBe("—")
  })

  it("always 2 decimals + space + h", () => {
    expect(formatHours(0)).toBe("0.00 h")
    expect(formatHours(1)).toBe("1.00 h")
    expect(formatHours(1.5)).toBe("1.50 h")
    expect(formatHours(1.567)).toBe("1.57 h")
    expect(formatHours(120)).toBe("120.00 h")
  })
})

// =============================================================================
// formatBytes
// =============================================================================

describe("formatBytes", () => {
  it("zero and non-finite both return '0 B'", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B")
  })

  it("bytes < 1 KiB plain", () => {
    expect(formatBytes(1)).toBe("1 B")
    expect(formatBytes(500)).toBe("500 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  it("KB with 1 decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(1024 * 999)).toBe("999.0 KB")
  })

  it("MB with 1 decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB")
    expect(formatBytes(1_500_000)).toBe("1.4 MB")
  })
})

// =============================================================================
// formatDuration
// =============================================================================

describe("formatDuration", () => {
  it("null returns em dash", () => {
    expect(formatDuration(null)).toBe("—")
  })

  it("non-finite returns em dash", () => {
    expect(formatDuration(Number.NaN)).toBe("—")
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—")
  })

  it("<1s in ms (no decimals)", () => {
    expect(formatDuration(0)).toBe("0 ms")
    expect(formatDuration(250)).toBe("250 ms")
    expect(formatDuration(999)).toBe("999 ms")
  })

  it("[1s, 1min) in seconds 1 decimal", () => {
    expect(formatDuration(1000)).toBe("1.0 s")
    expect(formatDuration(12_500)).toBe("12.5 s")
    expect(formatDuration(59_999)).toBe("60.0 s")
  })

  it("[1min, 1h) in minutes 1 decimal", () => {
    expect(formatDuration(60_000)).toBe("1.0 min")
    expect(formatDuration(90_000)).toBe("1.5 min")
    expect(formatDuration(3_599_999)).toBe("60.0 min")
  })

  it(">=1h in hours 2 decimals", () => {
    expect(formatDuration(3_600_000)).toBe("1.00 h")
    expect(formatDuration(5_400_000)).toBe("1.50 h")
    expect(formatDuration(86_400_000)).toBe("24.00 h")
  })
})

// =============================================================================
// relativeTime / relativeTimeFromMs
// =============================================================================

describe("relativeTimeFromMs", () => {
  const NOW = 1_700_000_000_000 // arbitrary fixed epoch ms
  let originalNow: typeof Date.now

  beforeEach(() => {
    originalNow = Date.now
    Date.now = () => NOW
  })
  afterEach(() => {
    Date.now = originalNow
  })

  it("non-finite returns em dash", () => {
    expect(relativeTimeFromMs(Number.NaN)).toBe("—")
    expect(relativeTimeFromMs(Number.POSITIVE_INFINITY)).toBe("—")
  })

  it("future timestamps clamp to 0s", () => {
    expect(relativeTimeFromMs(NOW + 5000)).toBe("0s ago")
  })

  it("<1min in seconds", () => {
    expect(relativeTimeFromMs(NOW - 5_000)).toBe("5s ago")
    expect(relativeTimeFromMs(NOW - 59_999)).toBe("60s ago")
  })

  it("<1h in minutes", () => {
    expect(relativeTimeFromMs(NOW - 60_000)).toBe("1m ago")
    expect(relativeTimeFromMs(NOW - 30 * 60_000)).toBe("30m ago")
  })

  it("<1d in hours", () => {
    expect(relativeTimeFromMs(NOW - 3_600_000)).toBe("1h ago")
    expect(relativeTimeFromMs(NOW - 12 * 3_600_000)).toBe("12h ago")
  })

  it(">=1d in days", () => {
    expect(relativeTimeFromMs(NOW - 86_400_000)).toBe("1d ago")
    expect(relativeTimeFromMs(NOW - 7 * 86_400_000)).toBe("7d ago")
  })
})

describe("relativeTime (ISO string variant)", () => {
  const NOW = 1_700_000_000_000
  let originalNow: typeof Date.now
  beforeEach(() => {
    originalNow = Date.now
    Date.now = () => NOW
  })
  afterEach(() => {
    Date.now = originalNow
  })

  it("delegates to relativeTimeFromMs after parsing the ISO", () => {
    const iso = new Date(NOW - 60_000).toISOString()
    expect(relativeTime(iso)).toBe("1m ago")
  })

  it("invalid ISO produces NaN.getTime() → em dash", () => {
    expect(relativeTime("not-a-date")).toBe("—")
  })
})

// =============================================================================
// resolveName
// =============================================================================

describe("resolveName", () => {
  it("missing id returns em dash", () => {
    const m = new Map<string, string>([["a", "Alice"]])
    expect(resolveName(m, undefined)).toBe("—")
    expect(resolveName(m, null)).toBe("—")
    expect(resolveName(m, "")).toBe("—") // empty string falsy
  })

  it("hit returns the mapped name", () => {
    const m = new Map([["user_a", "Alice"]])
    expect(resolveName(m, "user_a")).toBe("Alice")
  })

  it("miss returns the id itself (not em dash)", () => {
    const m = new Map([["user_a", "Alice"]])
    expect(resolveName(m, "user_xyz")).toBe("user_xyz")
  })
})

