/**
 * periodHours — pure helpers. Assertions that BITE:
 *   - newPeriodLimit is real addition (mutation to `-`/identity fails the 80+20 case),
 *   - validateHours enforces the EXACT [1,10000] integer boundary (0, 10001, 1.5,
 *     "", NaN, negatives all rejected; the endpoints accepted),
 *   - makeIdempotencyKey returns a fresh nonce each call in the allowed charset,
 *   - boostOriginMeta maps each source to its own label key + badge variant.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/billing/periodHours.render.test.ts
 */
import { describe, expect, it } from "vitest"
import {
  boostOriginMeta,
  HOURS_MAX,
  HOURS_MIN,
  makeIdempotencyKey,
  newPeriodLimit,
  validateHours,
} from "./periodHours"

describe("newPeriodLimit", () => {
  it("adds the granted hours to the effective limit", () => {
    expect(newPeriodLimit(80, 20)).toBe(100)
    expect(newPeriodLimit(0, 5)).toBe(5)
    expect(newPeriodLimit(72, 1)).toBe(73)
  })

  it("models a revoke as a negative delta", () => {
    expect(newPeriodLimit(100, -30)).toBe(70)
  })

  it("coerces non-finite inputs to 0 so the preview never shows NaN", () => {
    expect(newPeriodLimit(Number.NaN, 10)).toBe(10)
    expect(newPeriodLimit(80, Number.NaN)).toBe(80)
  })
})

describe("validateHours", () => {
  it("accepts whole numbers on and inside the [MIN, MAX] boundary", () => {
    expect(validateHours("20")).toEqual({ ok: true, hours: 20 })
    expect(validateHours(String(HOURS_MIN))).toEqual({ ok: true, hours: HOURS_MIN })
    expect(validateHours(String(HOURS_MAX))).toEqual({ ok: true, hours: HOURS_MAX })
    expect(validateHours("  5  ")).toEqual({ ok: true, hours: 5 })
  })

  it("rejects out-of-range, fractional, empty and non-numeric input", () => {
    expect(validateHours("0")).toEqual({ ok: false })
    expect(validateHours(String(HOURS_MAX + 1))).toEqual({ ok: false })
    expect(validateHours("1.5")).toEqual({ ok: false })
    expect(validateHours("-3")).toEqual({ ok: false })
    expect(validateHours("")).toEqual({ ok: false })
    expect(validateHours("   ")).toEqual({ ok: false })
    expect(validateHours("abc")).toEqual({ ok: false })
  })
})

describe("makeIdempotencyKey", () => {
  it("returns a fresh nonce each call in the [A-Za-z0-9_-] charset", () => {
    const a = makeIdempotencyKey()
    const b = makeIdempotencyKey()
    expect(a).not.toBe(b)
    for (const key of [a, b]) {
      expect(key.length).toBeGreaterThan(0)
      expect(key.length).toBeLessThanOrEqual(128)
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe("boostOriginMeta", () => {
  it("maps each source to its own label key and badge variant", () => {
    expect(boostOriginMeta("admin_grant")).toEqual({
      labelKey: "windows.usersPanel.billing.periodHours.origin.grant",
      variant: "info",
    })
    expect(boostOriginMeta("purchase")).toEqual({
      labelKey: "windows.usersPanel.billing.periodHours.origin.purchase",
      variant: "success",
    })
    expect(boostOriginMeta("access_request")).toEqual({
      labelKey: "windows.usersPanel.billing.periodHours.origin.request",
      variant: "gray",
    })
  })
})
