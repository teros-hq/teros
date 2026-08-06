import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  ChevronLeft,
  ListTree,
  XCircle,
} from "@tamagui/lucide-icons"
import { LEVEL_LABELS } from "@teros/shared"
import type { ReactNode } from "react"
import { Text, XStack, YStack } from "tamagui"
import { colors as semanticColors, surface } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"

/** The monitoring surfaces. `hub` has no chip (it's the breadcrumb root). */
export type MonitoringView = "hub" | "activity" | "models" | "trace"

/** Window types the header can drill to (what `onNavigate` receives). */
export type MonitoringTarget =
  | "monitoring"
  | "agent-usage"
  | "model-health"
  | "session-trace"

const VIEW_TARGET: Record<Exclude<MonitoringView, "hub">, MonitoringTarget> = {
  activity: "agent-usage",
  models: "model-health",
  trace: "session-trace",
}

// Text mirrors the ONE severity vocabulary (`LEVEL_LABELS`, TER-669) so every
// surface says the same word for a level — no more "Incident" here vs "Critical"
// in the KPI vs "All systems healthy" vs "Healthy". The keys stay the header's
// own enum (ok/degraded/error); only the words are unified.
const STATUS = {
  ok: { color: semanticColors.green, Icon: Check, text: LEVEL_LABELS.ok },
  degraded: { color: semanticColors.amber, Icon: AlertTriangle, text: LEVEL_LABELS.warn },
  error: { color: semanticColors.red, Icon: XCircle, text: LEVEL_LABELS.critical },
} as const

const CHIPS: { key: Exclude<MonitoringView, "hub">; label: string; Icon: typeof Activity }[] = [
  { key: "activity", label: "Agent Activity", Icon: Activity },
  { key: "models", label: "Model Health", Icon: BarChart3 },
  { key: "trace", label: "Session Trace", Icon: ListTree },
]

/**
 * Shared header for every monitoring window — the connective tissue of the suite.
 * Breadcrumb back to the hub + window title + a live status pill + "Related views"
 * chips (current one disabled). `onNavigate(target)` is wired by the window to
 * `openWindow(target)`, so the primitive stays free of the tiling store.
 */
export function MonitoringHeader({
  title,
  statusLevel = "ok",
  statusText,
  activeView,
  onNavigate,
  controls,
}: {
  title: string
  statusLevel?: keyof typeof STATUS
  statusText?: string
  activeView: MonitoringView
  onNavigate?: (target: MonitoringTarget) => void
  /**
   * Window controls (period selector, refresh…) rendered at the right end of
   * the second row — IN FLOW. Windows must NOT overlay controls with
   * `position="absolute"` on top of the header: that lands exactly on the
   * status pill (top-right of row 1) and covers it.
   */
  controls?: ReactNode
}) {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  const s = STATUS[statusLevel]
  return (
    <YStack
      gap={12}
      paddingVertical={16}
      paddingHorizontal={24}
      borderBottomWidth={1}
      borderBottomColor={c.border}
      backgroundColor={isDark ? "rgba(94,106,210,0.04)" : semanticColors.indigoGlow}
    >
      <XStack ai="center" jc="space-between" gap={16}>
        <XStack ai="center" gap={10} minWidth={0} flex={1}>
          <XStack
            ai="center"
            gap={4}
            cursor="pointer"
            hoverStyle={{ opacity: 0.8 }}
            onPress={() => onNavigate?.("monitoring")}
            aria-label="Back to Monitoring"
          >
            <ChevronLeft size={14} color={c.text3} />
            <Text fontSize={14} color={c.text3}>
              Monitoring
            </Text>
          </XStack>
          <Text fontSize={14} color={c.text3}>
            /
          </Text>
          <Text fontSize={20} fontWeight="650" color={c.text} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
        </XStack>
        <XStack
          ai="center"
          gap={8}
          paddingVertical={5}
          paddingHorizontal={11}
          borderRadius={9999}
          borderWidth={1}
          borderColor={`${s.color}38`}
          backgroundColor={`${s.color}1A`}
        >
          <YStack width={7} height={7} borderRadius={9999} backgroundColor={s.color} />
          <s.Icon size={13} color={s.color} />
          <Text fontSize={14} fontWeight="600" color={s.color} numberOfLines={1}>
            {statusText ?? s.text}
          </Text>
        </XStack>
      </XStack>

      <XStack ai="center" gap={12} flexWrap="wrap">
        <Text fontSize={12} fontWeight="600" letterSpacing={0.6} textTransform="uppercase" color={c.text3}>
          Related views
        </Text>
        <XStack ai="center" gap={8} flexWrap="wrap" flex={1}>
          {CHIPS.map(({ key, label, Icon }) => {
            const current = key === activeView
            return (
              <XStack
                key={key}
                ai="center"
                gap={6}
                paddingVertical={5}
                paddingHorizontal={11}
                borderRadius={9999}
                borderWidth={1}
                borderColor={current ? c.borderStrong : c.border}
                backgroundColor={current ? c.bgCardHover : c.bgInner}
                cursor={current ? "default" : "pointer"}
                hoverStyle={current ? {} : { backgroundColor: c.bgCardHover }}
                onPress={current ? undefined : () => onNavigate?.(VIEW_TARGET[key])}
                aria-label={current ? "Current view" : `Go to ${label}`}
              >
                <Icon size={13} color={current ? c.text : c.text2} />
                <Text fontSize={14} fontWeight="500" color={current ? c.text : c.text2}>
                  {label}
                </Text>
              </XStack>
            )
          })}
        </XStack>
        {controls ? (
          <XStack ai="center" gap={6}>
            {controls}
          </XStack>
        ) : null}
      </XStack>
    </YStack>
  )
}
