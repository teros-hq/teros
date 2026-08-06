/**
 * ConcaveCorner — reusable concave tab corner with SVG.
 *
 * Draws a quarter-circle arc that creates the concave effect where a tab
 * meets the content area. Uses separate fill and stroke paths so the border
 * only appears on the arc, not on the straight edges that overlap with the
 * tab's own border.
 *
 * Colors should be opaque — composite semi-transparent tokens over the
 * tab bar background before passing them here.
 *
 * Used by: TilingContainer (real tabs), UITestWindow (preview/testing)
 */

import { View } from "tamagui"

export const TAB_RADIUS = 12

interface ConcaveCornerProps {
  side: "left" | "right"
  borderColor: string
  backgroundColor: string
  /** Override the default radius (defaults to TAB_RADIUS) */
  radius?: number
}

export function ConcaveCorner({ side, borderColor, backgroundColor, radius }: ConcaveCornerProps) {
  const r = radius ?? TAB_RADIUS
  // Fill path: closed shape (arc + straight lines)
  const fillPath = side === "left"
    ? `M ${r} 0 A ${r} ${r} 0 0 1 0 ${r} L ${r} ${r} Z`
    : `M 0 0 A ${r} ${r} 0 0 0 ${r} ${r} L 0 ${r} Z`
  // Stroke path: just the arc, no closing line
  const strokePath = side === "left"
    ? `M ${r} 0 A ${r} ${r} 0 0 1 0 ${r}`
    : `M 0 0 A ${r} ${r} 0 0 0 ${r} ${r}`

  return (
    <View
      style={{
        position: "absolute",
        [side]: -r,
        bottom: 0,
        width: r,
        height: r,
        overflow: "hidden",
      }}
    >
      <svg
        width={r}
        height={r}
        style={{ display: "block", position: "absolute", bottom: 0 }}
      >
        <path d={fillPath} fill={backgroundColor} stroke="none" />
        <path
          d={strokePath}
          fill="none"
          stroke={borderColor}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </View>
  )
}
