/**
 * SignalsList — pure presentation of the F4·C2 signals dashboard rows.
 *
 * The backend sends structural DATA (name/description/states/occurrences/trend/
 * deepLinkUrl); the phrasing is composed here. Each card is a clickable deep link
 * into Latitude, accented by lifecycle state (escalating loudest), never by colour
 * alone — every state also shows as a labelled chip. Absent web URL → no link.
 */

import { Activity, ExternalLink, Tag } from "@tamagui/lucide-icons"
import { Linking, Platform } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import type { LatitudeSignalSummary } from "../../../services/AdminApi"
import {
  formatCount,
  formatPercent,
  formatWhen,
  SIGNAL_COLORS,
  signalAccent,
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

/** Compact 14-day trend as thin bars (height ∝ count). Dependency-free so it
 * renders in web, native, and the vitest harness alike. Empty trend → nothing. */
function Sparkline({ trend }: { trend: LatitudeSignalSummary["trend"] }) {
  if (trend.length === 0) return null
  const max = Math.max(1, ...trend.map((p) => p.count))
  return (
    <XStack ai="flex-end" gap={2} height={24} aria-label="14-day trend">
      {trend.map((p) => (
        <YStack
          key={p.bucket}
          width={3}
          height={Math.max(2, Math.round((p.count / max) * 24))}
          borderRadius={1}
          backgroundColor="$gray8"
        />
      ))}
    </XStack>
  )
}

function StateChip({ state }: { state: string }) {
  const color = SIGNAL_COLORS[stateLevel(state)]
  return (
    <XStack
      ai="center"
      gap={4}
      paddingHorizontal={7}
      paddingVertical={2}
      borderRadius={6}
      backgroundColor="rgba(255,255,255,0.05)"
      borderColor={color}
      borderWidth={1}
    >
      <YStack width={6} height={6} borderRadius={3} backgroundColor={color} />
      <Text fontSize={10} fontWeight="700" color={color} textTransform="uppercase">
        {state}
      </Text>
    </XStack>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <YStack gap={1}>
      <Text fontSize={9} color="$gray9" textTransform="uppercase" letterSpacing={0.4}>
        {label}
      </Text>
      <Text fontSize={12} fontWeight="600" color="$gray12">
        {value}
      </Text>
    </YStack>
  )
}

export function SignalCard({
  signal,
  onOpen,
}: {
  signal: LatitudeSignalSummary
  onOpen: (url: string) => void
}) {
  const accent = signalAccent(signal.states, signal.muted)
  const linkable = signal.deepLinkUrl.length > 0
  const label = `Signal: ${signal.name}. ${signal.muted ? "Muted. " : ""}${formatCount(
    signal.occurrences,
  )} occurrences.${linkable ? " Opens in Latitude." : ""}`
  return (
    <YStack
      gap={10}
      padding={14}
      borderRadius={12}
      backgroundColor="rgba(255,255,255,0.02)"
      borderColor="rgba(255,255,255,0.08)"
      borderWidth={1}
      borderLeftWidth={3}
      borderLeftColor={accent}
      opacity={signal.muted ? 0.72 : 1}
      cursor={linkable ? "pointer" : "default"}
      hoverStyle={linkable ? { backgroundColor: "rgba(255,255,255,0.05)" } : undefined}
      onPress={linkable ? () => onOpen(signal.deepLinkUrl) : undefined}
      aria-label={label}
      role={linkable ? "link" : undefined}
    >
      <XStack ai="center" gap={8} flexWrap="wrap">
        <Activity size={15} color={accent} />
        <Text fontSize={14} fontWeight="700" color="$gray12" flexShrink={1}>
          {signal.name}
        </Text>
        {signal.states.map((s) => (
          <StateChip key={s} state={s} />
        ))}
        {signal.muted ? (
          <Text fontSize={10} fontWeight="700" color="$gray9" textTransform="uppercase">
            Muted
          </Text>
        ) : null}
        <XStack flex={1} />
        {linkable ? <ExternalLink size={14} color="$gray9" /> : null}
      </XStack>

      {signal.description ? (
        <Text fontSize={12} color="$gray10" numberOfLines={2}>
          {signal.description}
        </Text>
      ) : null}

      <XStack ai="center" gap={20} flexWrap="wrap">
        <MetaItem label="Occurrences" value={formatCount(signal.occurrences)} />
        <MetaItem label="Sessions" value={formatPercent(signal.affectedSessionsPercent)} />
        <MetaItem label="Source" value={signal.source} />
        <MetaItem label="Last seen" value={formatWhen(signal.lastSeenAt)} />
        <XStack flex={1} />
        <Sparkline trend={signal.trend} />
      </XStack>

      {signal.tags.length > 0 ? (
        <XStack ai="center" gap={6} flexWrap="wrap">
          <Tag size={12} color="$gray9" />
          {signal.tags.map((t) => (
            <Text
              key={t}
              fontSize={10}
              color="$gray10"
              paddingHorizontal={6}
              paddingVertical={1}
              borderRadius={5}
              backgroundColor="rgba(255,255,255,0.05)"
            >
              {t}
            </Text>
          ))}
        </XStack>
      ) : null}
    </YStack>
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
    <YStack gap={10}>
      {signals.map((s) => (
        <SignalCard key={s.id} signal={s} onOpen={open} />
      ))}
    </YStack>
  )
}
