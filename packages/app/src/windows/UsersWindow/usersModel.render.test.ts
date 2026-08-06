/**
 * usersModel — pure helpers for the admin Users panel. These assertions BITE:
 * they pin the EXACT plan colour, the hours label/pct, the quota-colour
 * thresholds (0.79 vs 0.80 vs 1.0), and the compact relative-time buckets.
 *
 * Named *.render.test.ts so Vitest's `include` (src/**\/*.render.test.{ts,tsx})
 * runs it; it needs no DOM (pure functions), so there is no renderer here.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/usersModel.render.test.ts
 */
import { describe, expect, it } from "vitest"
import { tokens } from "../../components/monitoring/colors"
import type { BillingInfo } from "../../services/AdminApi"
import {
  formatCompact,
  formatCost,
  formatDate,
  formatRelative,
  hoursColor,
  hoursUsage,
  lastAccessSortValue,
  planBadge,
} from "./usersModel"

function billing(over: Partial<BillingInfo>): BillingInfo {
  return {
    planId: "plan_pro",
    planName: "Pro",
    status: "active",
    teamId: null,
    teamName: null,
    ...over,
  }
}

describe("planBadge", () => {
  it("maps known plans to their token colour, by name or by id", () => {
    expect(planBadge("plan_pro", "Pro")).toEqual({ label: "Pro", color: tokens.success })
    expect(planBadge("plan_growth", "Growth")).toEqual({ label: "Growth", color: tokens.accent })
    expect(planBadge("plan_starter", "Starter")).toEqual({
      label: "Starter",
      color: tokens.textTertiary,
    })
    // Resolves via the id (strip `plan_`) even without a name; label falls back to the id.
    expect(planBadge("plan_pro")).toEqual({ label: "plan_pro", color: tokens.success })
  })

  it("falls back to neutral tertiary for an unknown plan (chip never disappears)", () => {
    expect(planBadge("plan_mystery", "Mystery")).toEqual({
      label: "Mystery",
      color: tokens.textTertiary,
    })
  })
})

describe("hoursUsage", () => {
  it("returns a dash and zero state for no billing", () => {
    expect(hoursUsage(null)).toEqual({
      used: 0,
      limit: null,
      pct: null,
      unmetered: false,
      label: "—",
    })
  })

  it("returns ∞ and null pct for an unmetered plan", () => {
    expect(
      hoursUsage(billing({ unmetered: true, agentHoursUsed: 5, effectiveLimit: 999 })),
    ).toEqual({
      used: 5,
      limit: 999,
      pct: null,
      unmetered: true,
      label: "∞",
    })
  })

  it("formats used / limit and carries the backend pct", () => {
    expect(hoursUsage(billing({ agentHoursUsed: 48, effectiveLimit: 70, pct: 48 / 70 }))).toEqual({
      used: 48,
      limit: 70,
      pct: 48 / 70,
      unmetered: false,
      label: "48 / 70",
    })
  })

  it("derives pct from used/limit when the backend omits it", () => {
    expect(hoursUsage(billing({ agentHoursUsed: 5, effectiveLimit: 10 })).pct).toBe(0.5)
  })
})

describe("hoursColor", () => {
  it("thresholds: <0.8 secondary, ≥0.8 warning, ≥1 error", () => {
    expect(hoursColor(0.79, false)).toBe(tokens.textSecondary)
    expect(hoursColor(0.8, false)).toBe(tokens.warning)
    expect(hoursColor(0.999, false)).toBe(tokens.warning)
    expect(hoursColor(1.0, false)).toBe(tokens.error)
    expect(hoursColor(1.5, false)).toBe(tokens.error)
  })

  it("unmetered or unknown pct stays neutral tertiary", () => {
    expect(hoursColor(null, false)).toBe(tokens.textTertiary)
    expect(hoursColor(0.5, true)).toBe(tokens.textTertiary)
  })
})

describe("formatRelative", () => {
  it("buckets the age into compact tokens", () => {
    expect(formatRelative()).toBe("—")
    expect(formatRelative("nonsense")).toBe("—")
    expect(formatRelative(new Date(Date.now() - 10_000).toISOString())).toBe("now")
    expect(formatRelative(new Date(Date.now() - 30 * 60_000).toISOString())).toBe("30m")
    expect(formatRelative(new Date(Date.now() - 5 * 3_600_000).toISOString())).toBe("5h")
    expect(formatRelative(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2d")
  })

  it("falls back to an absolute date past 30 days", () => {
    expect(formatRelative("2020-06-15T12:00:00Z")).toBe("15 Jun 2020")
  })
})

describe("formatCost / formatCompact", () => {
  it("formatCost is USD with up to 2 decimals; dash on non-finite", () => {
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(12.5)).toBe("$12.50")
    expect(formatCost(1234.5)).toBe("$1,234.50")
    expect(formatCost(Number.NaN)).toBe("—")
  })

  it("formatCompact abbreviates large integers; dash on non-finite", () => {
    expect(formatCompact(950)).toBe("950")
    expect(formatCompact(12_300)).toBe("12.3K")
    expect(formatCompact(1_234_567)).toBe("1.2M")
    expect(formatCompact(Number.NaN)).toBe("—")
  })
})

describe("formatDate / lastAccessSortValue", () => {
  it("formatDate is en-GB short, dash on missing/invalid", () => {
    expect(formatDate("2020-06-15T12:00:00Z")).toBe("15 Jun 2020")
    expect(formatDate()).toBe("—")
    expect(formatDate("nope")).toBe("—")
  })

  it("lastAccessSortValue is epoch ms, 0 for missing/invalid (sorts oldest)", () => {
    expect(lastAccessSortValue("2020-06-15T12:00:00Z")).toBe(Date.parse("2020-06-15T12:00:00Z"))
    expect(lastAccessSortValue()).toBe(0)
    expect(lastAccessSortValue("nope")).toBe(0)
  })
})
