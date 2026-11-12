/**
 * InflightGauge — live count of LLM streams currently in flight per real
 * upstream (F1.3). A point-in-time reading of the backend's in-memory gauge
 * (NOT `status='running'`, which would leak crashed turns forever), so the
 * window polls it and shows how fresh the reading is. Pure presentation: the
 * polling lifecycle lives in `useInflightGauge`.
 *
 * A violet arc on the wash track (filling towards a soft ceiling of 10
 * concurrent streams, or the current total when higher) with the serif total
 * inside, then a thin proportional bar per upstream. Accessibility: numbers +
 * text, not colour alone.
 */

import React from "react"
import { View } from "react-native"
import { Circle, Svg } from "react-native-svg"
import { useColors } from "../../../components/mca/primitives/useColors"
import { T } from "../../../components/ui/ds/Text"

const SIZE = 132
const STROKE = 10

/** Soft ceiling for the arc: 10 streams reads as "full"; above that the arc stays full. */
const SOFT_MAX = 10

function Arc({ total }: { total: number }) {
  const c = useColors()
  const r = (SIZE - STROKE) / 2
  const cx = SIZE / 2
  const cy = SIZE / 2
  // Three-quarter arc (270°), open at the bottom — the classic gauge sweep.
  const sweep = 0.75
  const circumference = 2 * Math.PI * r
  const trackLen = circumference * sweep
  const frac = Math.max(0, Math.min(1, total / Math.max(SOFT_MAX, total)))
  const fillLen = trackLen * frac
  // Rotate so the gap sits at the bottom: start at 135° (bottom-left).
  const rotate = `rotate(135 ${cx} ${cy})`
  return (
    <View style={{ width: SIZE, height: SIZE, alignItems: "center", justifyContent: "center" }}>
      {React.createElement(
        Svg as any,
        { width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`, "aria-hidden": true },
        React.createElement(Circle as any, {
          cx,
          cy,
          r,
          fill: "none",
          stroke: c.wash2,
          strokeWidth: STROKE,
          strokeLinecap: "round",
          strokeDasharray: `${trackLen} ${circumference}`,
          transform: rotate,
        }),
        React.createElement(Circle as any, {
          cx,
          cy,
          r,
          fill: "none",
          stroke: c.accent,
          strokeWidth: STROKE,
          strokeLinecap: "round",
          strokeDasharray: `${fillLen} ${circumference}`,
          transform: rotate,
          opacity: total > 0 ? 1 : 0,
        }),
      )}
      <View
        style={{
          position: "absolute",
          alignItems: "center",
          justifyContent: "center",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      >
        <T step="2xl" color={total > 0 ? c.accent : c.text3} style={{ lineHeight: 40 }}>
          {total}
        </T>
        <T step="codenote" tone="text3">
          in flight
        </T>
      </View>
    </View>
  )
}

export function InflightGauge({
  inflight,
  total,
  capturedAt,
  error,
}: {
  inflight: Record<string, number>
  total: number
  capturedAt: string | null
  error: string | null
}) {
  const c = useColors()
  const entries = Object.entries(inflight)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  const maxN = Math.max(...entries.map(([, n]) => n), 1)

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <Arc total={total} />

        <View style={{ flex: 1, minWidth: 160, gap: 10 }}>
          {entries.length === 0 ? (
            <T step="sm" tone="text3">
              Idle — no streams in flight right now.
            </T>
          ) : (
            entries.map(([provider, n]) => (
              <View key={provider} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <T step="sm" tone="text2" numberOfLines={1} style={{ minWidth: 90 }}>
                  {provider}
                </T>
                <View
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: c.wash,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: c.accent,
                      width: `${(n / maxN) * 100}%`,
                    }}
                  />
                </View>
                <T step="code" style={{ minWidth: 28, textAlign: "right" }}>
                  {n}
                </T>
              </View>
            ))
          )}
        </View>
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <T step="12" tone="text3">
          {capturedAt
            ? `Updated ${new Date(capturedAt).toLocaleTimeString()} · this backend instance`
            : "Reading…"}
        </T>
        {error ? (
          <T step="12" color={c.tint.a.tx}>
            ⚠ {error}
          </T>
        ) : null}
      </View>
    </View>
  )
}
