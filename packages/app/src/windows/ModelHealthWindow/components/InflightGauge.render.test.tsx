import { describe, expect, it } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { InflightGauge } from "./InflightGauge"

describe("InflightGauge (F1.3)", () => {
  it("shows the idle state when nothing is in flight", () => {
    const { getByText } = renderWithTamagui(
      <InflightGauge inflight={{}} total={0} capturedAt="2026-06-30T10:00:00.000Z" error={null} />,
    )
    expect(getByText("Idle — no streams in flight right now.")).toBeTruthy()
  })

  it("shows the total and a row per upstream", () => {
    const { getByText } = renderWithTamagui(
      <InflightGauge
        inflight={{ fireworks: 2, together: 1 }}
        total={3}
        capturedAt="2026-06-30T10:00:00.000Z"
        error={null}
      />,
    )
    expect(getByText("3")).toBeTruthy() // the headline total
    expect(getByText("fireworks")).toBeTruthy()
    expect(getByText("together")).toBeTruthy()
  })

  it("hides zero-count upstreams (no noise rows)", () => {
    const { getByText, queryByText } = renderWithTamagui(
      <InflightGauge
        inflight={{ fireworks: 2, together: 0 }}
        total={2}
        capturedAt="2026-06-30T10:00:00.000Z"
        error={null}
      />,
    )
    expect(getByText("fireworks")).toBeTruthy()
    expect(queryByText("together")).toBeNull()
  })

  it("surfaces a poll error inline without blanking the gauge", () => {
    const { getByText } = renderWithTamagui(
      <InflightGauge inflight={{ fireworks: 1 }} total={1} capturedAt={null} error="WS closed" />,
    )
    expect(getByText("⚠ WS closed")).toBeTruthy()
    expect(getByText("fireworks")).toBeTruthy() // gauge still rendered
  })
})
