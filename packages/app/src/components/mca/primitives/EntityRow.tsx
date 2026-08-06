import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { useColors } from './useColors';

interface EntityRowProps {
  /** Slot izquierdo (Avatar, IconTile, StatusDot, etc). */
  leading?: React.ReactNode;
  /** Línea principal, negrita. */
  title: string;
  /** Línea secundaria opcional, muted. */
  subtitle?: React.ReactNode;
  /** Array de chips/badges a la derecha del title (p.ej. role, category). */
  badges?: React.ReactNode;
  /** Meta a la derecha del row (timestamp, count). */
  meta?: React.ReactNode;
  /** Callback al clickear la fila. Si se pasa, añade pressStyle. */
  onPress?: () => void;
  /** Trailing slot (ChevronRight para expandir, etc.). */
  trailing?: React.ReactNode;
}

export function EntityRow({
  leading,
  title,
  subtitle,
  badges,
  meta,
  onPress,
  trailing,
}: EntityRowProps): React.ReactNode {
  const c = useColors();
  return (
    <XStack
      gap={8}
      paddingHorizontal={8}
      paddingVertical={6}
      alignItems="center"
      borderBottomWidth={1}
      borderBottomColor={c.border}
      cursor={onPress ? 'pointer' : 'default'}
      onPress={onPress}
      pressStyle={
        onPress
          ? { backgroundColor: c.bgCardHover }
          : undefined
      }
      hoverStyle={
        onPress
          ? { backgroundColor: c.bgCardHover }
          : undefined
      }
    >
      {leading}
      <YStack flex={1} gap={2}>
        <XStack gap={6} alignItems="center">
          <Text color={c.text} fontSize={11} fontWeight="500" numberOfLines={1}>
            {title}
          </Text>
          {badges}
        </XStack>
        {subtitle && (
          <Text color={c.text2} fontSize={9} fontFamily="$mono" numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </YStack>
      {meta && (
        <XStack alignItems="center" gap={4}>
          {meta}
        </XStack>
      )}
      {trailing}
    </XStack>
  );
}
