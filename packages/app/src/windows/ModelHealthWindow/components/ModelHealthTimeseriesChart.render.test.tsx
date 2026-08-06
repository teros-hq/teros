import { describe, expect, it } from "vitest"
import type { ModelHealthHourBucket, ModelHealthSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { ModelHealthTimeseriesChart } from "./ModelHealthTimeseriesChart"

function model(actualProvider: string, modelId: string, requestCount: number): ModelHealthSummary {
  return {
    actualProvider,
    modelId,
    requestCount,
    latency: { count: requestCount, p50: null, p95: null, p99: null, mean: null },
    ttft: { count: requestCount, p50: null, p95: null, p99: null, mean: null },
    statusCounts: { completed: requestCount },
    errorCounts: {},
    errorRate: 0,
    successRate: 1,
  }
}

function bucket(iso: string, ...models: ModelHealthSummary[]): ModelHealthHourBucket {
  return { hourBucket: iso, models }
}

describe("ModelHealthTimeseriesChart (F1.2)", () => {
  it("shows an empty state when there are no buckets", () => {
    const { getByText } = renderWithTamagui(
      <ModelHealthTimeseriesChart series={[]} bucketTimeZone="UTC" />,
    )
    expect(getByText("No request volume in range")).toBeTruthy()
  })

  it("shows the empty state when buckets carry zero requests (not a blank chart)", () => {
    const series = [bucket("2026-06-30T10:00:00.000Z", model("fireworks", "kimi", 0))]
    const { getByText } = renderWithTamagui(
      <ModelHealthTimeseriesChart series={series} bucketTimeZone="UTC" />,
    )
    expect(getByText("No request volume in range")).toBeTruthy()
  })

  it("announces bucket count + total turns in the wrapper aria-label", () => {
    const series = [
      bucket("2026-06-30T10:00:00.000Z", model("fireworks", "kimi", 3)),
      bucket("2026-06-30T11:00:00.000Z", model("fireworks", "kimi", 5)),
    ]
    const { container } = renderWithTamagui(
      <ModelHealthTimeseriesChart series={series} bucketTimeZone="UTC" />,
    )
    const labelled = container.querySelector('[aria-label*="hourly buckets"]')
    expect(labelled).toBeTruthy()
    // 2 buckets, 3 + 5 = 8 turns — the headline must reflect the real sum.
    expect(labelled?.getAttribute("aria-label")).toContain("2 hourly buckets")
    expect(labelled?.getAttribute("aria-label")).toContain("8 turns total")
  })

  it("lists each upstream×model in the legend", () => {
    const series = [
      bucket(
        "2026-06-30T10:00:00.000Z",
        model("fireworks", "kimi-k2p6", 4),
        model("together", "kimi-k2.6", 2),
      ),
    ]
    const { getByText } = renderWithTamagui(
      <ModelHealthTimeseriesChart series={series} bucketTimeZone="UTC" />,
    )
    // modelLabel drops the path + joins with "·"; legend appends the total.
    expect(getByText(/fireworks·kimi-k2p6/)).toBeTruthy()
    expect(getByText(/together·kimi-k2\.6/)).toBeTruthy()
  })
})
