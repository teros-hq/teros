/**
 * RetentionBadge — compact pill showing a model/provider's data-retention tier.
 *
 * Use next to a model or provider name in any picker so the user sees the
 * posture at a glance (🟢 zero retention / 🟡 retains / 🔴 trains on your data).
 * Pair with <RetentionNotice> for the full explanation when one is selected.
 */

import { Text, XStack } from 'tamagui'
import { useTranslation } from 'react-i18next'
import type { RetentionInfo } from '@teros/shared'
import { RETENTION_VISUALS } from './retentionStyle'

interface RetentionBadgeProps {
  info: RetentionInfo
  /** Smaller paddings/text for dense lists (dropdown rows, grid cards). */
  compact?: boolean
}

export function RetentionBadge({ info, compact = false }: RetentionBadgeProps) {
  const { t } = useTranslation()
  const visual = RETENTION_VISUALS[info.tier]
  const { Icon } = visual

  return (
    <XStack
      testID={`retention-badge-${info.tier}`}
      alignItems="center"
      gap={4}
      paddingHorizontal={compact ? 6 : 8}
      paddingVertical={compact ? 2 : 3}
      borderRadius={999}
      backgroundColor={visual.bg}
      borderWidth={1}
      borderColor={visual.border}
    >
      <Icon size={compact ? 10 : 12} color={visual.fg} />
      <Text fontSize={compact ? 9 : 11} fontWeight="600" color={visual.fg}>
        {t(`dataRetention.tier.${info.tier}.label`)}
      </Text>
    </XStack>
  )
}
