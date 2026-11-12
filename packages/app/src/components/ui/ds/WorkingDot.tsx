/** WorkingDot (native) — a plain dot; the animated point is web-only (see WorkingDot.web.tsx). */
import React from "react"
import { View } from "react-native"

export function WorkingDot({ size = 8, color = "#F59E0B" }: { size?: number; color?: string }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, flexShrink: 0 }} />
}
