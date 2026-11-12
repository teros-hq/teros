import { ChevronRight, ShieldAlert } from "./icons"
import { useTranslation } from "react-i18next"
import type React from "react"
import { useEffect, useRef } from "react"
import { Animated, Easing, Platform } from "react-native"
import { Image, View as TView, XStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { McaIcon } from "../McaIcon"
import { Badge } from "./Badge"
import { statusDotColors, surface, type McaStatusType } from "./colors"
import { APPROVAL_BORDER_HOVER, APPROVAL_LIFT, isLiveStatus } from "./Containers"
import { fx } from "../../../styles/fx"
import { statusFill } from "./StatusDot"
import { useColors } from "./useColors"

// Wave keyframes for the DESCRIPTION TEXT — a light band tinted with the
// status color sweeps left-to-right across the text while the call is alive
// (the glare/shimmer pattern from ProfileWindow's unlimited hero and the
// chat's message-queue shimmer, miniaturized). The sweep runs on the
// compositor thread and survives Tamagui re-renders. Injected once at module
// load, same pattern as StatusDot's keyframes.
const TEXT_WAVE_KEYFRAMES_ID = "mca-header-text-wave-keyframes"
if (Platform.OS === "web" && typeof document !== "undefined") {
  if (!document.getElementById(TEXT_WAVE_KEYFRAMES_ID)) {
    const style = document.createElement("style")
    style.id = TEXT_WAVE_KEYFRAMES_ID
    style.textContent =
      "@keyframes mca-header-text-wave { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }"
    document.head.appendChild(style)
  }
}

export interface HeaderRowProps {
  status: McaStatusType
  description: string
  iconUri?: string
  /**
   * The app's display name (`HubSpot`), shown after the icon in the tertiary
   * colour before the description: "HubSpot · Create a new HubSpot contact".
   * Omitted while unknown — no placeholder.
   *
   * @spec PERMW-REQ-4
   */
  appName?: string
  badge?: React.ReactNode
  /**
   * Binary marker (Renderer UX Guide v2 §8). When `true`, the irreversibility
   * indicator is rendered in the header just before the chevron. No risk
   * levels, no gradations — either present or absent.
   */
  irreversible?: boolean
  /**
   * Binary marker (Renderer UX Guide v2.1 §8.5). When `true`, the Risk
   * Indicator amber badge is rendered between the badge and the
   * Irreversibility marker. Same binary rule as §8 — no gradations,
   * the literal text is just "risk". Activates for security-elevated
   * or blast-radius idioms even when the action is technically
   * reversible (chmod 777, sudo, curl|sh, kubectl --all, etc.).
   */
  risk?: boolean
  expanded: boolean
  onToggle: () => void
  isInContainer?: boolean
  /**
   * @deprecated The header no longer shows a tool-name pill (the app icon
   *   plus the description carry the identity). Accepted and ignored so
   *   existing callers keep compiling.
   */
  toolName?: string
  /**
   * @deprecated Renderer UX Guide v2 §7 forbids duration in the header.
   *   Accepted only as a backwards-compat shim while consumers migrate to
   *   the new ToolCallCard contract. The value is silently ignored —
   *   nothing is rendered. Migration sweep in Fase 5 removes the prop
   *   from every caller.
   */
  duration?: number
  /**
   * @deprecated Same rationale as `duration` — extension props from older
   *   bespoke headers (Bash exit code, etc.) survived as a backwards-
   *   compat shim. The value is silently ignored. Bash-style metadata
   *   should now live in the body (Fase 3 Fallback Body / custom renderer).
   */
  exitCode?: number
}

// Header anatomy — dev's simplified header on the OS prototype's chrome.
// Immutable order:
//
//   [1] App icon    — 14px from iconUri, TINTED WITH THE STATUS FILL
//                     (running = amber, pulsing; done green; failed red;
//                     waiting violet). The icon IS the state signal — there
//                     is no status dot and no tool-name pill.
//   [2] App name    — optional, text3, "HubSpot · " (PERMW-REQ-4)
//   [2] Description — sans 14, flex:1, single-line, ellipsis on overflow
//   [3] Badge       — optional, max 1 contextual signal
//   [4] Risk / Irreversible markers — amber / red badges
//   [5] Chevron     — animated 0→90deg, status-tinted, pulses in sync
//
// Chrome: inside an `ExpandedContainer` the row is transparent — the card
// paints the wash. Standalone (collapsed card, or a renderer composing the
// header on its own) it paints the `.approval` chrome itself: radius 16,
// violet wash + hairline while live, quiet nest card once settled.
//
// Notes:
// • No duration is rendered (guide §7 DON'T list).
// • No "running"/"awaiting" auxiliary text — the icon encodes state.
// • Header never wraps to two lines.
/** @spec PERMW-REQ-4 */
export function HeaderRow({
  status,
  description,
  iconUri,
  appName,
  badge,
  irreversible,
  risk,
  expanded,
  onToggle,
  isInContainer,
  toolName: _toolName, // ignored — no tool pill in the header
  duration: _duration, // back-compat shim, intentionally unused (guide v2 §7)
  exitCode: _exitCode, // back-compat shim, intentionally unused
}: HeaderRowProps) {
  const c = useColors()
  const { t } = useTranslation()
  const isDark = c.bgPage === surface.dark.bgPage
  const live = isLiveStatus(status)
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current

  // Live status colour — icon and chevron both carry the state's fill
  // (running = amber, pulsing). One concept, one colour, two signals.
  const statusColor = statusFill(status, c.accent)
  // Same clock as the old StatusDot (mca-status-pulse keyframes, injected by
  // StatusDot.tsx at module load): icon and chevron pulse in sync.
  const iconPulseStyle =
    statusDotColors[status].pulse && Platform.OS === "web"
      ? ({ animation: "mca-status-pulse 1.6s infinite ease-in-out" } as object)
      : undefined

  // The text carries a WAVE while the call is alive: a light band sweeps
  // across it (glare pattern, miniaturized). The band is a light gray, not
  // the status color — the wave reads as a passing sheen, not a color
  // change: pure white on dark (a glare), text3 on light (two steps lighter
  // than the base text — visible but still a gray, not a recolor). Band
  // spans 25%→75% of the 200% gradient so the sheen is clearly visible.
  // Web-only (background-clip: text); native keeps the plain text.
  const textWaveStyle =
    statusDotColors[status].pulse && Platform.OS === "web"
      ? ({
          backgroundImage: `linear-gradient(90deg, ${c.text} 25%, ${isDark ? "#FFFFFF" : c.text3} 50%, ${c.text} 75%)`,
          backgroundSize: "200% 100%",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          animation: "mca-header-text-wave 3.2s linear infinite",
        } as object)
      : undefined

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start()
  }, [expanded, rotateAnim])

  // On web, the RN Animated `transform: [{ rotate }]` interpolation doesn't
  // produce a CSS transform that re-renders smoothly — Tamagui re-renders
  // wipe it. We use a plain CSS transition on `transform` instead; the
  // value (90deg / 0deg) is recomputed each render and the browser animates
  // between them. On native, the Animated.Value path stays intact.
  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "90deg"],
  })

  // App icon — 14px. SVG (mono, `currentColor`) renders inline via McaIcon,
  // TINTED WITH THE STATUS FILL so the app mark itself carries the state.
  // Raster (PNG) icons can't be tinted and keep their brand pixels; the
  // chevron still carries the state for them. No icon → dashed placeholder.
  const iconNode = iconUri ? (
    iconUri.endsWith(".svg") || iconUri.includes("image/svg") ? (
      <TView style={iconPulseStyle}>
        <McaIcon icon={iconUri} size={14} borderRadius={2} color={statusColor} />
      </TView>
    ) : (
      <Image source={{ uri: iconUri }} width={14} height={14} borderRadius={3} />
    )
  ) : (
    <XStack
      width={14}
      height={14}
      borderRadius={3}
      borderWidth={1}
      borderStyle="dashed"
      borderColor={c.borderStrong}
      flexShrink={0}
    />
  )

  const hoverBorder = live ? APPROVAL_BORDER_HOVER : c.borderStrong

  return (
    <XStack
      alignItems="center"
      gap={10}
      paddingVertical={10}
      paddingHorizontal={14}
      // Standalone: the `.approval` chrome. In a container: transparent, the
      // container paints the wash and owns the hover.
      // Live standalone: an OPAQUE box on the sheet colour with the violet
      // cloud blooming behind it (prototype `.approval`).
      backgroundColor={isInContainer ? "transparent" : live ? c.bgBox : c.bgStep}
      borderRadius={isInContainer ? 0 : 16}
      borderWidth={!isInContainer && live ? 1 : 0}
      borderColor="transparent"
      {...(!isInContainer && live && Platform.OS === "web" ? fx("cloud") : {})}
      {...(!isInContainer && !live && Platform.OS === "web"
        ? ({ boxShadow: c.liftSm } as any)
        : {})}
      hoverStyle={
        isInContainer
          ? { backgroundColor: "transparent" }
          : {
              ...(live ? { borderColor: hoverBorder } : {}),
              ...(Platform.OS === "web"
                ? ({ boxShadow: live ? APPROVAL_LIFT : c.liftSmHover } as any)
                : {}),
            }
      }
      onPress={onToggle}
      cursor="pointer"
      // Guide §1: tap the header to toggle. Announce as a button to
      // screen readers with the current expansion state so VoiceOver/
      // TalkBack speak "Tool call header, button, expanded/collapsed".
      // Tamagui XStack on web doesn't propagate `accessibilityState`
      // → `aria-expanded`, so we set it explicitly as an HTML attribute.
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      {...(Platform.OS === "web"
        ? ({
            "aria-expanded": expanded,
            style: { transition: "border-color 0.35s, box-shadow 0.35s cubic-bezier(.16,1,.3,1)" },
          } as any)
        : {})}
    >
      {/* [1] App icon — the state signal */}
      {iconNode}

      {/* [2] App name — tertiary, before the description; never shrinks to
          nothing while the description takes the ellipsis. */}
      {appName ? (
        <T
          step="sm"
          tone="text3"
          numberOfLines={1}
          testID="header-app-name"
          style={{ flexShrink: 0, maxWidth: "40%", fontSize: 14, lineHeight: 20, marginRight: -6 }}
        >
          {`${appName} ·`}
        </T>
      ) : null}

      {/* [2] Description — flex, single-line, ellipsis. While the call is
          alive a light band WAVES across the text (see textWaveStyle). */}
      <T
        step="sm"
        numberOfLines={1}
        ellipsizeMode="tail"
        style={[{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20 }, textWaveStyle ?? null]}
      >
        {description}
      </T>

      {/* [3] Badge — optional, max 1 contextual signal */}
      {badge}

      {/* [4] Risk Indicator — binary, between badge and irreversibility marker.
          Amber (vs irreversible's red) to communicate the orthogonal axis.
          The literal "risk" text — no gradations per guide v2.1 §8.5. */}
      {risk && (
        <XStack
          accessible
          accessibilityRole="alert"
          accessibilityLabel={t("mca.permission.riskAriaLabel")}
          flexShrink={0}
        >
          <Badge
            text={t("mca.permission.risk")}
            variant="warning"
            icon={<ShieldAlert size={10} color={c.tint.a.tx} />}
          />
        </XStack>
      )}

      {/* Irreversibility marker — binary, between badge and chevron.
          a11y: announced as "alert" so screen readers raise the
          warning ahead of the trailing chevron. The icon is decorative;
          the text + accessibilityLabel carry meaning. For deuteranopia,
          the literal "irreversible" word is the primary signal. */}
      {irreversible && (
        <XStack
          accessible
          accessibilityRole="alert"
          accessibilityLabel={t("mca.permission.irreversibleAriaLabel")}
          flexShrink={0}
        >
          <Badge
            text={t("mca.permission.irreversible")}
            variant="error"
            icon={<ShieldAlert size={10} color={c.tint.r.tx} />}
          />
        </XStack>
      )}

      {/* [5] Chevron — animated 0→90deg, status-tinted, pulsing with the icon.
          Web path: plain transform string + CSS transition (RN Animated
          `[{rotate}]` doesn't survive Tamagui re-renders in web). Native
          path: the original Animated.View. */}
      {Platform.OS === "web" ? (
        <TView
          // `transition` is a web-only CSS property (no RN ViewStyle key).
          // The cast must stay opaque (`as object`) — narrowing it to
          // `React.CSSProperties` contaminates the type inference when
          // Tamagui composes the style and breaks neighbouring RN keys.
          style={
            {
              transform: `rotate(${expanded ? 90 : 0}deg)`,
              transition: "transform 150ms ease-in-out",
              ...(iconPulseStyle as object),
            } as object
          }
        >
          <ChevronRight size={12} color={statusColor} />
        </TView>
      ) : (
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <ChevronRight size={12} color={statusColor} />
        </Animated.View>
      )}
    </XStack>
  )
}
