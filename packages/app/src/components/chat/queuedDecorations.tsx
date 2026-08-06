import { Clock3 } from '@tamagui/lucide-icons'
import type React from 'react'
import { Platform } from 'react-native'
import { Text, View, XStack } from 'tamagui'
import { useColors } from '../mca/primitives/useColors'
import { colors as semanticColors } from '../mca/primitives/colors'
import { useTranslation } from 'react-i18next'
import { installShimmerKeyframes } from './shimmerKeyframes'

installShimmerKeyframes()

/**
 * Overlay con linear-gradient + translateX que crea el shimmer skeleton.
 * Pensado para ir como primer hijo de un contenedor con `position: relative`
 * y `overflow: hidden`. Sólo web; nativo cae a un overlay estático tenue.
 *
 * Los colores del gradiente y del fallback nativo se adaptan al tema activo
 * usando `useColors()` para evitar valores hardcoded de blanco que son
 * invisibles en light mode.
 */
export function QueuedShimmer(): React.ReactElement {
  const c = useColors()

  // Usar el color de borde fuerte del tema como base para el shimmer,
  // con un alpha que sea visible tanto en light como en dark.
  const shimmerColor = c.borderStrong

  const webStyle =
    Platform.OS === 'web'
      ? ({
          background: `linear-gradient(90deg, transparent 0%, ${shimmerColor} 50%, transparent 100%)`,
          animation: 'message-queue-shimmer 1.8s linear infinite',
        } as object)
      : { backgroundColor: c.border }

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        ...webStyle,
      }}
    />
  )
}

export function QueuedIndicator({
  color = semanticColors.indigoLight,
}: { color?: string }): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()

  return (
    <XStack alignItems="center" gap={4}>
      <Clock3 size={11} color={color} />
      <Text fontSize="$1" color={color} fontWeight="500" fontFamily="$body">
        {t('chat.queued')}
      </Text>
    </XStack>
  )
}
