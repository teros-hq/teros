import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useChartWidth } from "./useChartWidth"

const layout = (width: number) => ({ nativeEvent: { layout: { width } } })

describe("useChartWidth", () => {
  it("returns the fallback until a layout is measured", () => {
    const { result } = renderHook(() => useChartWidth(720))
    expect(result.current[0]).toBe(720)
  })

  it("swaps in the measured width once onLayout fires", () => {
    const { result } = renderHook(() => useChartWidth(720))
    act(() => result.current[1](layout(512)))
    expect(result.current[0]).toBe(512)
  })

  it("ignores non-positive widths and keeps the fallback", () => {
    const { result } = renderHook(() => useChartWidth(300))
    act(() => result.current[1](layout(0)))
    expect(result.current[0]).toBe(300)
  })

  it("rounds the width and ignores sub-pixel jitter (avoids re-render churn)", () => {
    const { result } = renderHook(() => useChartWidth())
    act(() => result.current[1](layout(400.4)))
    expect(result.current[0]).toBe(400)
    // 400.9 rounds to 401 — within 1px of 400 — so the measured value is left alone.
    act(() => result.current[1](layout(400.9)))
    expect(result.current[0]).toBe(400)
  })
})
