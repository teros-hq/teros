import type { Activity } from "@tamagui/lucide-icons"
import type { ReactNode } from "react"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "./colors"

/**
 * KPI tile — stat variant (mono value + unit + delta + optional sparkline slot)
 * or status variant (colored value + status icon + sub). Matches the design's
 * hub/activity/model-health KPI strips.
 */
export function KpiTile({
  icon: Icon,
  label,
  value,
  unit,
  delta,
  deltaColor,
  sub,
  valueColor,
  statusColor,
  statusIcon: StatusIcon,
  sparkline,
}: {
  icon?: typeof Activity
  label: string
  value: string
  unit?: string
  delta?: string
  deltaColor?: string
  sub?: string
  valueColor?: string
  statusColor?: string
  statusIcon?: typeof Activity
  sparkline?: ReactNode
}) {
  return (
    <YStack backgroundColor={tokens.bgCard} padding={16} gap={8} minWidth={0} flex={1}>
      <XStack ai="center" gap={6}>
        {Icon ? <Icon size={13} color={tokens.textTertiary} /> : null}
        <Text
          fontSize={10}
          fontWeight="600"
          letterSpacing={0.6}
          textTransform="uppercase"
          color={tokens.textTertiary}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {label}
        </Text>
      </XStack>
      {statusColor ? (
        <>
          <XStack ai="center" gap={7}>
            {StatusIcon ? <StatusIcon size={18} color={statusColor} /> : null}
            <Text fontSize={20} fontWeight="700" color={statusColor}>
              {value}
            </Text>
          </XStack>
          {sub ? (
            <Text fontSize={11} color={tokens.textTertiary} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <XStack ai="baseline" gap={4}>
            <Text fontFamily="$mono" fontSize={26} fontWeight="600" color={valueColor ?? tokens.text}>
              {value}
            </Text>
            {unit ? <Text fontSize={12} color={tokens.textTertiary}>{unit}</Text> : null}
          </XStack>
          {delta || sparkline ? (
            <XStack ai="center" jc="space-between" gap={8}>
              <Text fontFamily="$mono" fontSize={11} fontWeight="600" color={deltaColor ?? tokens.textTertiary} numberOfLines={1}>
                {delta ?? ""}
              </Text>
              {sparkline ? (
                <YStack flex={1} maxWidth={120} height={30} minWidth={0}>
                  {sparkline}
                </YStack>
              ) : null}
            </XStack>
          ) : null}
          {sub ? (
            <Text fontSize={11} color={tokens.textTertiary} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </>
      )}
    </YStack>
  )
}

/**
 * Row of KPI tiles with hairline dividers (the design's `gap:1px; background:border`
 * grid). Tiles wrap responsively; the container paints the divider color behind them.
 */
export function KpiStrip({ children }: { children: ReactNode }) {
  return (
    <XStack
      flexWrap="wrap"
      gap={1}
      backgroundColor={tokens.border}
      borderBottomWidth={1}
      borderBottomColor={tokens.border}
    >
      {children}
    </XStack>
  )
}

/** Section title + optional right slot, wrapping content. The design's chart/table sections. */
export function SectionCard({
  title,
  right,
  children,
}: {
  title: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <YStack gap={12}>
      <XStack ai="baseline" jc="space-between" gap={10}>
        <Text fontSize={16} fontWeight="640" color={tokens.text}>
          {title}
        </Text>
        {right}
      </XStack>
      {children}
    </YStack>
  )
}
