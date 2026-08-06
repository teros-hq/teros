/**
 * useChartWidth — measures the real width of a chart's container so the
 * hand-rolled SVG charts (PercentileBandChart, LatencyHeatmap) fill their `Card`
 * instead of a fixed 720px box. Returns `[width, onLayout]`; `width` starts at
 * `fallback` so the very first render (and the jsdom render tests, where
 * `onLayout` never fires — no ResizeObserver, rAF is a no-op) still draws
 * content. `onLayout` then swaps in the measured width on mount/resize.
 *
 * Kept out of the SVG bodies because both charts need the exact same fallback
 * behaviour and the design brief (TER-616 / R7.2) asks for measured-width
 * responsiveness, not a viewBox scale (their height must NOT scale with width).
 */
import { useCallback, useState } from "react"

type LayoutEvent = { nativeEvent: { layout: { width: number } } }

export function useChartWidth(fallback = 720): [number, (e: LayoutEvent) => void] {
  const [measured, setMeasured] = useState(0)
  const onLayout = useCallback((e: LayoutEvent) => {
    const w = Math.round(e.nativeEvent.layout.width)
    if (w > 0) setMeasured((prev) => (Math.abs(prev - w) > 1 ? w : prev))
  }, [])
  return [measured > 0 ? measured : fallback, onLayout]
}
