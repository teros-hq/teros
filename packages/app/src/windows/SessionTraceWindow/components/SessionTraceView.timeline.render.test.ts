import { describe, expect, it } from "vitest"
import type { TraceEvent, TraceSession } from "../../../services/AdminApi"
import { buildTimeline, eventDurationMs } from "./SessionTraceView"

const session = (durationMs: number | null = 4000): TraceSession =>
  ({ durationMs }) as unknown as TraceSession
const llm = (at: string, latencyMs: number | null): TraceEvent =>
  ({ kind: "llm", at, llm: { latencyMs } }) as unknown as TraceEvent
const tool = (at: string, durationMs: number | null): TraceEvent =>
  ({ kind: "tool", at, tool: { durationMs } }) as unknown as TraceEvent

describe("eventDurationMs", () => {
  it("reads latencyMs for LLM calls and durationMs for tools", () => {
    expect(eventDurationMs(llm("x", 1200))).toBe(1200)
    expect(eventDurationMs(tool("x", 300))).toBe(300)
  })
  it("treats null / non-finite / non-positive durations as zero", () => {
    expect(eventDurationMs(llm("x", null))).toBe(0)
    expect(eventDurationMs(tool("x", -5))).toBe(0)
  })
})

describe("buildTimeline", () => {
  it("falls back to a sequential waterfall when timestamps don't differ", () => {
    // Same (unparseable) `at` → no usable spread → lay events end-to-start.
    const { rows } = buildTimeline([tool("na", 1000), tool("na", 3000)], session(null))
    // rawTotal = 4000 → nice total 4000; positions/widths are exact percentages of it.
    expect(rows[0]).toMatchObject({ startMs: 0, durMs: 1000, leftPct: 0, wPct: 25 })
    expect(rows[1]).toMatchObject({ startMs: 1000, durMs: 3000, leftPct: 25, wPct: 75 })
  })

  it("positions bars by real timestamps when they have spread", () => {
    const { rows } = buildTimeline(
      [
        llm("2026-06-30T10:00:00.000Z", 500),
        tool("2026-06-30T10:00:02.000Z", 500),
      ],
      session(3000),
    )
    // t0 = first event; second starts 2000ms later. Scaled to nice total 3000.
    expect(rows[0].startMs).toBe(0)
    expect(rows[1].startMs).toBe(2000)
    expect(rows[1].leftPct).toBeCloseTo(66.667, 2)
    expect(rows[0].wPct).toBeCloseTo(16.667, 2)
  })

  it("stays sequential if any timestamp is unusable (mixed validity)", () => {
    const { rows } = buildTimeline(
      [llm("2026-06-30T10:00:00.000Z", 1000), tool("n/a", 1000)],
      session(null),
    )
    // Not all valid → sequential, so the second bar starts after the first's duration.
    expect(rows[1].startMs).toBe(1000)
  })

  it("floors a zero-duration bar to a visible minimum width", () => {
    const { rows } = buildTimeline([tool("na", 0)], session(null))
    expect(rows[0].durMs).toBe(0)
    expect(rows[0].wPct).toBe(1.4)
  })

  it("emits five axis ticks spanning 0→100% labelled in seconds", () => {
    const { ticks } = buildTimeline([tool("na", 4000)], session(null))
    expect(ticks).toHaveLength(5)
    expect(ticks[0]).toEqual({ pct: 0, label: "0s" })
    expect(ticks[4]).toEqual({ pct: 100, label: "4s" })
  })
})
