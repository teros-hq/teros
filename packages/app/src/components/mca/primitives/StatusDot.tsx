import { Animated, Platform } from "react-native"
import { usePulseAnimation } from "../../../hooks/usePulseAnimation"
import { type McaStatusType, statusDotColors } from "./colors"
import { MCA_STRINGS } from "./strings"
import { useColors } from "./useColors"

interface StatusDotProps {
  status: McaStatusType
  size?: number
}

/**
 * Web pulse keyframes — injected once at module load. `Animated.loop` on web
 * does NOT produce a CSS @keyframes rule (it just toggles opacity in JS,
 * which Tamagui re-renders can interrupt and the DOM ends up reporting
 * `animationName: none`). Injecting a real CSS keyframes rule guarantees the
 * pulse runs on the compositor thread, smooth and immune to re-renders.
 *
 * Native (iOS/Android) keeps using the existing `usePulseAnimation` hook —
 * `useNativeDriver: true` there does the equivalent on the native thread.
 */
const PULSE_KEYFRAMES_ID = "mca-status-pulse-keyframes"
if (Platform.OS === "web" && typeof document !== "undefined") {
  if (!document.getElementById(PULSE_KEYFRAMES_ID)) {
    const style = document.createElement("style")
    style.id = PULSE_KEYFRAMES_ID
    style.textContent =
      "@keyframes mca-status-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }"
    document.head.appendChild(style)
  }
}

/**
 * Fill colour of a status in the OS prototype: running amber (pulsing), done
 * green, failed red — and everything that waits (queued, awaiting approval,
 * awaiting a form) is the theme violet, i.e. `useColors().accent`. The
 * `statusDotColors` table keeps the pre-prototype orange for `pending`; the
 * accent is passed in because it is theme-adaptive (Purple/300 on light,
 * Purple/200 on dark) and this module must stay usable without the hook.
 */
export function statusFill(status: McaStatusType, accent: string): string {
  if (status === "running" || status === "completed" || status === "failed") {
    return statusDotColors[status].fill
  }
  return accent
}

// 5-state status indicator (Renderer UX Guide v2 §3).
// Color and pulse are determined automatically by status — never overridden
// by a renderer. `pending` (violet, no pulse) joins the 4 legacy states.
//
// A11y: the colour + pulse are decorative. The primary signal for screen
// readers is `accessibilityLabel`, mapped from `MCA_STRINGS.status[status]`.
// Treated as `image` role so VoiceOver/TalkBack announce "image, running"
// rather than parsing the View as ambient layout. Critical for users who
// can't distinguish the colour ramp (deuteranopia gets red↔green wrong).
export function StatusDot({ status, size = 6 }: StatusDotProps) {
  const c = useColors()
  const dot = statusDotColors[status]
  const fill = statusFill(status, c.accent)
  const pulseAnim = usePulseAnimation(dot.pulse)

  // Web: CSS keyframes (works on compositor thread, survives re-renders).
  // Native: Animated.Value driven on the native thread.
  //
  // `animation` is a web-only CSS property not present in `ViewStyle`. RN
  // Web passes it through to the DOM, but the cast must be opaque (`as
  // object`) — typing it as `React.CSSProperties` would contaminate the
  // surrounding spread and re-type sibling RN keys (`width`, `height`,
  // `borderRadius`) as CSS shapes, breaking the Animated.View signature.
  const pulseStyle =
    dot.pulse && Platform.OS === "web"
      ? ({ animation: "mca-status-pulse 1.6s infinite ease-in-out" } as object)
      : { opacity: dot.pulse ? pulseAnim : 1 }

  return (
    <Animated.View
      accessible
      accessibilityRole="image"
      accessibilityLabel={MCA_STRINGS.status[status]}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: fill,
        flexShrink: 0,
        shadowColor: fill,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: dot.pulse ? 0.6 : 0.35,
        shadowRadius: 3,
        elevation: 3,
        ...pulseStyle,
      }}
    />
  )
}
