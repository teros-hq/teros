import { useEffect, useState } from "react"
import { Platform } from "react-native"
import { bubbleSpot, byZ, frontId, type Viewport } from "../../../store/floatGeometry"
import { useNavbarStore } from "../../../store/navbarStore"
import { useTilingStore } from "../../../store/tilingStore"
import { COLLAPSED_WIDTH, EXPANDED_WIDTH } from "../../navbarV2/primitives"
import { FloatBubble } from "./FloatBubble"
import { FloatFrame, type FloatMode } from "./FloatFrame"
import { installFloatMotion } from "./floatMotion"
import { useFloatShortcut } from "./useFloatShortcut"

const NARROW = 768

function readViewport(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight }
}

function useViewport(): Viewport {
  const [vp, setVp] = useState(readViewport)
  useEffect(() => {
    const onResize = () => {
      setVp(readViewport())
      if (window.innerWidth >= NARROW) useTilingStore.getState().fitFloats()
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  return vp
}

function WebLayer() {
  const floats = useTilingStore((s) => s.floats)
  const windows = useTilingStore((s) => s.windows)
  const compact = useTilingStore((s) => s.compactShell)
  const sheetId = useTilingStore((s) => s.floatSheetId)
  const tabDrag = useTilingStore(
    (s) => s.globalDragWindowId !== null || s.globalDragWindowIds.length > 0,
  )
  const navExpanded = useNavbarStore((s) => s.isExpanded)
  const vp = useViewport()
  useFloatShortcut()
  useEffect(installFloatMotion, [])
  useEffect(() => {
    if (!compact && useTilingStore.getState().floatSheetId)
      useTilingStore.setState({ floatSheetId: null })
  }, [compact])

  const known = Object.fromEntries(Object.entries(floats).filter(([id]) => windows[id]))
  const ids = Object.keys(known).sort()
  if (ids.length === 0) return null

  const sheet = compact && sheetId && known[sheetId] ? sheetId : null
  const front = compact ? sheet : frontId(known)
  const modeOf = (id: string): FloatMode => {
    if (compact) return id === sheet ? "sheet" : "hidden"
    return known[id].minimized ? "hidden" : "frame"
  }
  const bubbles = byZ(known).filter((id) => modeOf(id) === "hidden")
  const navWidth = compact ? 0 : navExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH

  return (
    <div
      data-floating-layer=""
      data-tab-drag={String(tabDrag)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        pointerEvents: "none",
        overflow: "hidden",
        opacity: tabDrag ? 0.35 : 1,
        transition: "opacity 120ms",
      }}
    >
      {sheet ? (
        <div
          data-float-scrim=""
          onClick={() => useTilingStore.getState().minimizeFloat(sheet, true)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 600,
            pointerEvents: "auto",
            background: "rgba(0,0,0,0.32)",
          }}
        />
      ) : null}
      {ids.map((id) => (
        <FloatFrame
          key={id}
          window={windows[id]}
          entry={known[id]}
          mode={modeOf(id)}
          front={id === front}
        />
      ))}
      {bubbles.map((id, index) => {
        const spot = bubbleSpot(index, vp, navWidth, compact)
        return (
          <FloatBubble
            key={id}
            window={windows[id]}
            x={spot.x}
            y={spot.y}
            labelSide={compact ? "left" : "right"}
          />
        )
      })}
    </div>
  )
}

export function FloatingWindowLayer() {
  if (Platform.OS !== "web") return null
  return <WebLayer />
}
