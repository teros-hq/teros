import { describe, expect, it } from "vitest"
import {
  errorRateLevel,
  fallbackLevel,
  formatCount,
  formatMs,
  formatPct,
  latencyLevel,
  modelLabel,
  saturationLevel,
  toolErrorLevel,
  truncationLevel,
  worseLevel,
} from "./format"

/**
 * The threshold logic drives the accessible status colours (blue→orange→red)
 * paired with icon+text, so the boundaries are pinned exactly. Pure functions —
 * mutation-verifiable.
 */
describe("format — thresholds (TER-616)", () => {
  it("latencyLevel: latency p95 boundaries (warn 4s, critical 10s)", () => {
    expect(latencyLevel("latency", null)).toBe("ok")
    expect(latencyLevel("latency", 3999)).toBe("ok")
    expect(latencyLevel("latency", 4000)).toBe("warn")
    expect(latencyLevel("latency", 9999)).toBe("warn")
    expect(latencyLevel("latency", 10000)).toBe("critical")
  })

  it("latencyLevel: TTFT boundaries are tighter (warn 2s, critical 5s)", () => {
    expect(latencyLevel("ttft", 1999)).toBe("ok")
    expect(latencyLevel("ttft", 2000)).toBe("warn")
    expect(latencyLevel("ttft", 5000)).toBe("critical")
  })

  it("errorRateLevel: 1% warn, 5% critical", () => {
    expect(errorRateLevel(0)).toBe("ok")
    expect(errorRateLevel(0.009)).toBe("ok")
    expect(errorRateLevel(0.01)).toBe("warn")
    expect(errorRateLevel(0.049)).toBe("warn")
    expect(errorRateLevel(0.05)).toBe("critical")
  })

  it("worseLevel picks the more severe (critical > warn > ok)", () => {
    expect(worseLevel("ok", "warn")).toBe("warn")
    expect(worseLevel("warn", "ok")).toBe("warn")
    expect(worseLevel("warn", "critical")).toBe("critical")
    expect(worseLevel("ok", "ok")).toBe("ok")
  })

  it("saturationLevel: 5% warn, 15% critical (R6.2)", () => {
    expect(saturationLevel(0.04)).toBe("ok")
    expect(saturationLevel(0.05)).toBe("warn")
    expect(saturationLevel(0.15)).toBe("critical")
  })

  it("fallbackLevel: 1% warn, 5% critical (R3.5)", () => {
    expect(fallbackLevel(0.009)).toBe("ok")
    expect(fallbackLevel(0.01)).toBe("warn")
    expect(fallbackLevel(0.05)).toBe("critical")
  })

  it("toolErrorLevel: 5% warn, 20% critical (R4.3)", () => {
    expect(toolErrorLevel(0.04)).toBe("ok")
    expect(toolErrorLevel(0.05)).toBe("warn")
    expect(toolErrorLevel(0.2)).toBe("critical")
  })

  it("truncationLevel: 5% warn, 20% critical (§3.1)", () => {
    expect(truncationLevel(0.04)).toBe("ok")
    expect(truncationLevel(0.05)).toBe("warn")
    expect(truncationLevel(0.2)).toBe("critical")
  })

  it("rate levels treat a non-finite rate as ok (no NaN colour)", () => {
    expect(saturationLevel(Number.NaN)).toBe("ok")
    expect(fallbackLevel(Number.POSITIVE_INFINITY)).toBe("ok")
  })
})

describe("format — formatters", () => {
  it("formatMs: ms under 1s, seconds above", () => {
    expect(formatMs(820)).toBe("820ms")
    expect(formatMs(3400)).toBe("3.40s")
    expect(formatMs(12100)).toBe("12.1s")
    expect(formatMs(Number.NaN)).toBe("—")
  })

  it("formatPct: one decimal under 10%, none above", () => {
    expect(formatPct(0.034)).toBe("3.4%")
    expect(formatPct(0.5)).toBe("50%")
    expect(formatPct(Number.NaN)).toBe("—")
  })

  it("formatCount: thousands separators", () => {
    expect(formatCount(1234567)).toBe("1,234,567")
  })

  it("modelLabel: drops provider path prefix and truncates", () => {
    expect(modelLabel("fireworks", "accounts/fireworks/models/kimi-k2p6", 40)).toBe(
      "fireworks·kimi-k2p6",
    )
    expect(modelLabel("together", "moonshotai/kimi-k2.6", 40)).toBe("together·kimi-k2.6")
    expect(modelLabel("fireworks", "a-very-long-model-name-indeed", 16)).toHaveLength(16)
  })
})
