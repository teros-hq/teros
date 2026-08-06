import { describe, expect, it } from "vitest"
import type { ModelHealthSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { PercentileBandChart } from "./PercentileBandChart"

function model(
  actualProvider: string,
  modelId: string,
  latP95: number,
  ttftP95: number,
  count = 10,
): ModelHealthSummary {
  return {
    actualProvider,
    modelId,
    requestCount: count,
    latency: { count, p50: latP95 * 0.6, p95: latP95, p99: latP95 * 1.2, mean: latP95 * 0.7 },
    ttft: { count, p50: ttftP95 * 0.6, p95: ttftP95, p99: ttftP95 * 1.2, mean: ttftP95 * 0.7 },
    statusCounts: { completed: count },
    errorCounts: {},
    errorRate: 0,
    successRate: 1,
  }
}

describe("PercentileBandChart (TER-616)", () => {
  it("shows an empty state when no model has samples for the metric", () => {
    const { getByText } = renderWithTamagui(<PercentileBandChart models={[]} metric="latency" />)
    expect(getByText("No latency samples in range")).toBeTruthy()
  })

  it("shows the TTFT-specific empty state when models lack TTFT samples", () => {
    const noTtft: ModelHealthSummary = {
      ...model("fireworks", "kimi", 1200, 0),
      ttft: { count: 0, p50: null, p95: null, p99: null, mean: null },
    }
    const { getByText } = renderWithTamagui(<PercentileBandChart models={[noTtft]} metric="ttft" />)
    expect(getByText("No TTFT samples in range")).toBeTruthy()
  })

  it("renders a band per model and exposes every model in the wrapper aria-label", () => {
    const models = [
      model("fireworks", "kimi-k2p6", 1200, 300),
      model("together", "kimi-k2.6", 800, 200),
    ]
    const { container } = renderWithTamagui(
      <PercentileBandChart models={models} metric="latency" />,
    )
    const labelled = container.querySelector('[aria-label*="fireworks"]')
    expect(labelled).toBeTruthy()
    expect(labelled?.getAttribute("aria-label")).toContain("together")
    expect(labelled?.getAttribute("aria-label")).toContain("p95")
  })
})
