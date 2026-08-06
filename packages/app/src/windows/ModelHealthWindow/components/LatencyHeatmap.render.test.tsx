import { describe, expect, it } from "vitest"
import type { ModelHealthHourBucket, ModelHealthSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { LatencyHeatmap } from "./LatencyHeatmap"

function m(actualProvider: string, modelId: string, p95: number | null, count = 10): ModelHealthSummary {
  return {
    actualProvider,
    modelId,
    requestCount: count,
    latency: { count: p95 == null ? 0 : count, p50: p95 == null ? null : p95 * 0.6, p95, p99: p95 == null ? null : p95 * 1.2, mean: p95 == null ? null : p95 * 0.7 },
    ttft: { count, p50: 120, p95: 240, p99: 360, mean: 180 },
    statusCounts: { completed: count },
    errorCounts: {},
    errorRate: 0,
    successRate: 1,
  } as ModelHealthSummary
}
const hour = (iso: string, models: ModelHealthSummary[]): ModelHealthHourBucket => ({ hourBucket: iso, models })

describe("LatencyHeatmap (TER-616 · model × hour p95)", () => {
  it("shows an empty state when there are no hour buckets", () => {
    const { getByText } = renderWithTamagui(<LatencyHeatmap series={[]} metric="latency" />)
    expect(getByText("No latency distribution in range")).toBeTruthy()
  })

  it("shows an empty state when no cell has a p95 sample", () => {
    const { getByText } = renderWithTamagui(
      <LatencyHeatmap series={[hour("2026-06-30T10:00:00Z", [m("fireworks", "kimi", null)])]} metric="latency" />,
    )
    expect(getByText("No latency distribution in range")).toBeTruthy()
  })

  it("renders the model × hour grid and announces the model count + p95 span", () => {
    const series = [
      hour("2026-06-30T10:00:00Z", [m("fireworks", "kimi-k2p6", 800), m("anthropic", "opus", 2000)]),
      hour("2026-06-30T11:00:00Z", [m("fireworks", "kimi-k2p6", 1200)]),
    ]
    const { container } = renderWithTamagui(<LatencyHeatmap series={series} metric="latency" width={760} />)
    const el = container.querySelector('[aria-label*="p95 heatmap"]')
    expect(el).toBeTruthy()
    // Not colour-alone: the model count and the min→max p95 span ride in the label.
    expect(el?.getAttribute("aria-label")).toContain("2 models")
    expect(el?.getAttribute("aria-label")).toContain("2 hours")
  })
})
