/**
 * Health-NOW logic (TER-669 / A5.1): the Hub badge must reflect the LAST buckets,
 * not a range aggregate — a two-hour-old blip must not keep the badge red all day.
 */
import { describe, expect, it } from "vitest"
import { recentHealthLevel } from "./MonitoringWindowContent"

// Minimal ModelHealthHourBucket shape the function reads.
const model = (over: Partial<any> = {}) => ({
  actualProvider: "fireworks",
  modelId: "gpt-4o",
  latency: { p95: 500 },
  errorRate: 0,
  ...over,
})
const bucket = (models: any[]) => ({ hourBucket: "2026-06-30T10:00:00Z", models })

describe("recentHealthLevel", () => {
  it("reflects only the last 2 non-empty buckets, not the whole range", () => {
    // An early CRITICAL bucket must NOT keep the badge red once recent buckets
    // are healthy. Mutation: reducing over ALL buckets makes this critical → red.
    const series = [
      bucket([model({ errorRate: 0.9 })]), // old incident (critical)
      bucket([]), // quiet
      bucket([model({ errorRate: 0 })]), // recent: healthy
      bucket([model({ errorRate: 0 })]), // recent: healthy
    ]
    expect(recentHealthLevel(series as any)).toBe("ok")
  })

  it("is critical when a RECENT bucket is critical (standard model, error 5%)", () => {
    const series = [
      bucket([model({ errorRate: 0 })]),
      bucket([model({ errorRate: 0.06 })]), // recent critical
    ]
    expect(recentHealthLevel(series as any)).toBe("critical")
  })

  it("uses per-model latency class: a reasoning model at 9s TTFT/high p95 is not critical", () => {
    const series = [bucket([model({ modelId: "kimi", latency: { p95: 38000 }, errorRate: 0 })])]
    // 38s p95 is within the reasoning band (warn), not critical.
    expect(recentHealthLevel(series as any)).toBe("warn")
  })

  it("is ok for an empty / all-quiet series (nothing failing right now)", () => {
    expect(recentHealthLevel([] as any)).toBe("ok")
    expect(recentHealthLevel([bucket([]), bucket([])] as any)).toBe("ok")
  })
})
