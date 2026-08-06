/**
 * Pure billing-audit derivations (TER-596 A1). The window itself is stubbed by
 * the render harness (every *WindowContent → no-op), so the logic that matters
 * lives in audit.ts and bites here. Each assertion targets a mutation:
 *   - the drift rule matches the reconciliation cron EXACTLY (0.5h OR 10%),
 *     including the strict-greater boundaries,
 *   - usagePercent rounds (a floor mutation shows the wrong %) and is null when
 *     unmetered,
 *   - boostOrigin distinguishes a purchase from an admin grant.
 *
 *   cd packages/app && npx vitest run src/windows/BillingAuditWindow/audit.render.test.ts
 */
import { describe, expect, it } from "vitest"
import { boostOrigin, isDriftSignificant, usagePercent } from "./audit"

describe("isDriftSignificant", () => {
  it("is false exactly at the 0.5h absolute boundary", () => {
    // strict-greater: 0.5h is in sync, a >= mutation would flip this to true.
    expect(isDriftSignificant(0.5, 100, 99.5)).toBe(false)
  })

  it("is true just above 0.5h absolute", () => {
    // pct is negligible → only the absolute rule can trip it.
    expect(isDriftSignificant(0.51, 100000, 99999.49)).toBe(true)
  })

  it("is false exactly at 10% of max(expected, actual) under the abs threshold", () => {
    // 0.4h on a denom of 4h = 10% exactly, abs 0.4 < 0.5 → not significant.
    expect(isDriftSignificant(0.4, 4, 3.6)).toBe(false)
  })

  it("is true above 10% even below 0.5h absolute", () => {
    // 0.45h on 4h = 11.25% > 10%, abs 0.45 < 0.5 → the % rule trips it.
    expect(isDriftSignificant(0.45, 4, 3.55)).toBe(true)
  })

  it("matches the cron on OVER-consumption: denominator is max(expected, actual) (M3)", () => {
    // expected=4.3, actual=4.75, drift=0.45. The cron's denom = max = 4.75 →
    // 0.45/4.75 = 9.47% < 10% → NOT significant. The old code divided by `expected`
    // (0.45/4.3 = 10.47% > 10%) and falsely flagged it.
    // MUST BITE: reverting the denominator to `expected` flips this to true.
    expect(isDriftSignificant(0.45, 4.3, 4.75)).toBe(false)
  })

  it("reproduces the cron formula across an expected/actual grid (parity guard)", () => {
    // The frontend cannot import the backend cron; this pins the formula instead
    // (the guard the docstring promises). Replicate the cron exactly and assert
    // isDriftSignificant agrees on every cell — especially actual > expected.
    const DRIFT_ABS = 0.5
    const DRIFT_PCT = 0.1
    const cron = (expected: number, actual: number) => {
      const drift = Math.abs(actual - expected)
      const denom = Math.max(expected, actual)
      return drift > DRIFT_ABS || (denom > 0 && drift / denom > DRIFT_PCT)
    }
    for (const expected of [0, 1, 4, 4.3, 10, 100]) {
      for (const actual of [0, 0.4, 1, 4.4, 4.75, 9, 12, 110]) {
        const drift = Math.abs(actual - expected)
        expect(isDriftSignificant(drift, expected, actual)).toBe(cron(expected, actual))
      }
    }
  })
})

describe("usagePercent", () => {
  it("rounds to the nearest integer", () => {
    // 70/80 = 87.5 → 88 (a floor mutation would give 87).
    expect(usagePercent(70, 80)).toBe(88)
  })

  it("is null for an unmetered plan (limit 0)", () => {
    expect(usagePercent(5, 0)).toBeNull()
  })
})

describe("boostOrigin", () => {
  it("is a purchase when a purchaseId is present", () => {
    expect(boostOrigin({ purchaseId: "boost-purchase:u:1" })).toBe("purchase")
  })

  it("is a grant when there is no purchaseId", () => {
    expect(boostOrigin({ purchaseId: null })).toBe("grant")
  })
})
