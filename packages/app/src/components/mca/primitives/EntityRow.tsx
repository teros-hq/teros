import type React from "react"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

interface EntityRowProps {
  /** Slot izquierdo (Avatar, IconTile, StatusDot, etc). */
  leading?: React.ReactNode
  /** Línea principal (sans 13). */
  title: string
  /** Línea secundaria opcional, mono 11 text3. */
  subtitle?: React.ReactNode
  /** Array de chips/badges a la derecha del title (p.ej. role, category). */
  badges?: React.ReactNode
  /** Meta a la derecha del row (timestamp, count). */
  meta?: React.ReactNode
  /** Callback al clickear la fila. Si se pasa, añade pressStyle. */
  onPress?: () => void
  /** Trailing slot (ChevronRight para expandir, etc.). */
  trailing?: React.ReactNode
}

/** A list row (`.lrow`): hairline separator, nest wash on hover when pressable. */
export function EntityRow({
  leading,
  title,
  subtitle,
  badges,
  meta,
  onPress,
  trailing,
}: EntityRowProps): React.ReactNode {
  const c = useColors()
  return (
    <XStack
      gap={10}
      paddingHorizontal={10}
      paddingVertical={8}
      alignItems="center"
      borderBottomWidth={1}
      borderBottomColor={c.border}
      cursor={onPress ? "pointer" : "default"}
      onPress={onPress}
      pressStyle={onPress ? { backgroundColor: c.nestHover } : undefined}
      hoverStyle={onPress ? { backgroundColor: c.nestHover } : undefined}
    >
      {leading}
      <YStack flex={1} minWidth={0} gap={2}>
        <XStack gap={6} alignItems="center">
          <T step="sm" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </T>
          {badges}
        </XStack>
        {subtitle && (
          <T step="code" tone="text3" numberOfLines={1} style={{ fontSize: 11, lineHeight: 14 }}>
            {subtitle}
          </T>
        )}
      </YStack>
      {meta && (
        <XStack alignItems="center" gap={6} flexShrink={0}>
          {meta}
        </XStack>
      )}
      {trailing}
    </XStack>
  )
}
