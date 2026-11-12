import { LEVEL_LABELS } from "@teros/shared"
import type { ReactNode } from "react"
import { View, useWindowDimensions } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Badge, type BadgeTone } from "../ui/ds/Badge"
import { ChipBtn } from "../ui/ds/Buttons"
import { T } from "../ui/ds/Text"

/** The monitoring surfaces. `hub` has no chip (it's the breadcrumb root). */
export type MonitoringView = "hub" | "activity" | "models" | "trace"

/** Window types the header can drill to (what `onNavigate` receives). */
export type MonitoringTarget = "monitoring" | "agent-usage" | "model-health" | "session-trace"

const VIEW_TARGET: Record<Exclude<MonitoringView, "hub">, MonitoringTarget> = {
  activity: "agent-usage",
  models: "model-health",
  trace: "session-trace",
}

// Text mirrors the ONE severity vocabulary (`LEVEL_LABELS`, TER-669) so every
// surface says the same word for a level — no more "Incident" here vs "Critical"
// in the KPI vs "All systems healthy" vs "Healthy". The keys stay the header's
// own enum (ok/degraded/error); only the words are unified.
const STATUS: Record<"ok" | "degraded" | "error", { tone: BadgeTone; icon: string; text: string }> =
  {
    ok: { tone: "g", icon: "check", text: LEVEL_LABELS.ok },
    degraded: { tone: "a", icon: "warning", text: LEVEL_LABELS.warn },
    error: { tone: "r", icon: "x-circle", text: LEVEL_LABELS.critical },
  }

const CHIPS: { key: Exclude<MonitoringView, "hub">; label: string; icon: string }[] = [
  { key: "activity", label: "Agent Activity", icon: "pulse" },
  { key: "models", label: "Model Health", icon: "chart-bar" },
  { key: "trace", label: "Session Trace", icon: "tree-structure" },
]

/**
 * Shared header for every monitoring window — the connective tissue of the
 * suite, drawn as the OS prototype's page head: accent eyebrow + live status
 * badge, serif title, and a row of view chips (hub first, the current one
 * lit) with the window controls at the right end. `onNavigate(target)` is
 * wired by the window to `openWindow(target)`, so the primitive stays free of
 * the tiling store.
 */
export function MonitoringHeader({
  title,
  statusLevel = "ok",
  statusText,
  activeView,
  onNavigate,
  controls,
  lead,
}: {
  title: string
  statusLevel?: keyof typeof STATUS
  statusText?: string
  activeView: MonitoringView
  onNavigate?: (target: MonitoringTarget) => void
  /**
   * Window controls (period selector, refresh…) rendered at the right end of
   * the chips row — IN FLOW. Windows must NOT overlay controls with
   * `position="absolute"` on top of the header.
   */
  controls?: ReactNode
  /** Optional lead sentence under the title. */
  lead?: string
}) {
  const c = useColors()
  const { width } = useWindowDimensions()
  const s = STATUS[statusLevel]
  const isHub = activeView === "hub"
  return (
    <View style={{ gap: 16, marginBottom: 20 }}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <T step="xs" tone="accent">
            Monitorización
          </T>
          <Badge tone={s.tone} dot icon={s.icon} pill>
            {statusText ?? s.text}
          </Badge>
        </View>
        <T step="3xl" numberOfLines={2}>
          {title}
        </T>
        {lead ? (
          <T step="lg" tone="text2" style={{ maxWidth: 560 }}>
            {lead}
          </T>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            flex: 1,
            minWidth: width <= 620 ? "100%" : 320,
          }}
        >
          <ChipBtn
            icon={isHub ? "chart-line-up" : "caret-left"}
            on={isHub}
            onPress={isHub ? undefined : () => onNavigate?.("monitoring")}
            disabled={isHub}
            accessibilityLabel={isHub ? "Current view" : "Back to Monitoring"}
            {...({ "aria-label": isHub ? "Current view" : "Back to Monitoring" } as any)}
            style={isHub ? { opacity: 1 } : undefined}
          >
            Monitoring
          </ChipBtn>
          {CHIPS.map(({ key, label, icon }) => {
            const current = key === activeView
            return (
              <ChipBtn
                key={key}
                icon={icon}
                on={current}
                disabled={current}
                onPress={current ? undefined : () => onNavigate?.(VIEW_TARGET[key])}
                accessibilityLabel={current ? "Current view" : `Go to ${label}`}
                {...({ "aria-label": current ? "Current view" : `Go to ${label}` } as any)}
                style={current ? { opacity: 1 } : undefined}
              >
                {label}
              </ChipBtn>
            )
          })}
        </View>
        {controls ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {controls}
          </View>
        ) : null}
      </View>
    </View>
  )
}
