/**
 * SignalsList — pure presentation of the F4·C2 signals dashboard rows.
 *
 * The backend sends structural DATA (name/description/states/occurrences/trend/
 * deepLinkUrl); the phrasing is composed here. The list is an `LGroup` of rows,
 * each a clickable deep link into Latitude, accented by lifecycle state
 * (escalating loudest) — never by colour alone: every state also shows as a
 * labelled `Badge`. Absent web URL → no link.
 */

import { Linking, Platform, View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Badge } from "../../../components/ui/ds/Badge"
import { LGroup, LRow } from "../../../components/ui/ds/Card"
import { Ph } from "../../../components/ui/ds/Icon"
import { T } from "../../../components/ui/ds/Text"
import { Tile } from "../../../components/ui/ds/Tile"
import type { LatitudeSignalSummary } from "../../../services/AdminApi"
import {
  formatCount,
  formatPercent,
  formatWhen,
  SIGNAL_TONE,
  signalLevel,
  stateLevel,
} from "../format"

export function openSignal(url: string) {
  if (!url) return
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer")
  } else {
    Linking.openURL(url).catch(() => {})
  }
}

/** Compact 14-day trend as thin violet bars (height ∝ count). Dependency-free so it
 * renders in web, native, and the vitest harness alike. Empty trend → nothing. */
function Sparkline({ trend }: { trend: LatitudeSignalSummary["trend"] }) {
  const c = useColors()
  if (trend.length === 0) return null
  const max = Math.max(1, ...trend.map((p) => p.count))
  return (
    <View
      style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 24 }}
      {...({ "aria-label": "14-day trend" } as any)}
    >
      {trend.map((p) => (
        <View
          key={p.bucket}
          style={{
            width: 3,
            height: Math.max(2, Math.round((p.count / max) * 24)),
            borderRadius: 1,
            backgroundColor: c.accent,
            opacity: 0.35 + (p.count / max) * 0.65,
          }}
        />
      ))}
    </View>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 1, minWidth: 72 }}>
      <T step="codenote" tone="text3">
        {label}
      </T>
      <T step="code13" numberOfLines={1}>
        {value}
      </T>
    </View>
  )
}

export function SignalCard({
  signal,
  onOpen,
}: {
  signal: LatitudeSignalSummary
  onOpen: (url: string) => void
}) {
  const c = useColors()
  const level = signalLevel(signal.states, signal.muted)
  const linkable = signal.deepLinkUrl.length > 0
  const label = `Signal: ${signal.name}. ${signal.muted ? "Muted. " : ""}${formatCount(
    signal.occurrences,
  )} occurrences.${linkable ? " Opens in Latitude." : ""}`
  const tileTone =
    level === "bad" ? "pink" : level === "warn" ? "amber" : level === "info" ? "accent" : "muted"
  return (
    <LRow
      padV={14}
      gap={14}
      onPress={linkable ? () => onOpen(signal.deepLinkUrl) : undefined}
      style={{ alignItems: "flex-start", opacity: signal.muted ? 0.72 : 1 }}
      {...({
        "aria-label": label,
        ...(linkable ? { role: "link", accessibilityRole: "link" } : {}),
      } as any)}
    >
      <Tile sm tone={tileTone} icon="broadcast" />

      <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <T step="base" style={{ flexShrink: 1 }}>
            {signal.name}
          </T>
          {signal.states.map((s) => (
            <Badge key={s} tone={SIGNAL_TONE[stateLevel(s)]} dot pill>
              {s}
            </Badge>
          ))}
          {signal.muted ? (
            <Badge tone="muted" pill>
              Muted
            </Badge>
          ) : null}
        </View>

        {signal.description ? (
          <T step="sm" tone="text2" numberOfLines={2}>
            {signal.description}
          </T>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          <MetaItem label="Occurrences" value={formatCount(signal.occurrences)} />
          <MetaItem label="Sessions" value={formatPercent(signal.affectedSessionsPercent)} />
          <MetaItem label="Source" value={signal.source} />
          <MetaItem label="Last seen" value={formatWhen(signal.lastSeenAt)} />
          <View style={{ flex: 1 }} />
          <Sparkline trend={signal.trend} />
        </View>

        {signal.tags.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Ph name="tag" size={12} color={c.text3} />
            {signal.tags.map((t) => (
              <Badge key={t} mono sm>
                {t}
              </Badge>
            ))}
          </View>
        ) : null}
      </View>

      {linkable ? (
        <Ph name="arrow-square-out" size={14} color={c.text3} style={{ marginTop: 4 }} />
      ) : null}
    </LRow>
  )
}

export function SignalsList({
  signals,
  onOpenSignal,
}: {
  signals: LatitudeSignalSummary[]
  onOpenSignal?: (url: string) => void
}) {
  const open = onOpenSignal ?? openSignal
  return (
    <LGroup>
      {signals.map((s) => (
        <SignalCard key={s.id} signal={s} onOpen={open} />
      ))}
    </LGroup>
  )
}
