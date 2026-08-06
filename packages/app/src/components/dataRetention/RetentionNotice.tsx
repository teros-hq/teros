/**
 * RetentionNotice — inline banner explaining what happens to the user's data
 * for the selected model/provider, with the concrete action when one exists
 * (opt out of training, move to the paid tier, enable a ZDR filter…).
 *
 * Non-blocking by design: it informs, it does not gate the choice. Render it
 * for the currently selected provider/model. Safe to render for the `zdr` tier
 * too — it then reads as reassurance ("nothing is stored").
 */

import { Text, XStack } from 'tamagui'
import { useTranslation } from 'react-i18next'
import type { RetentionInfo } from '@teros/shared'
import { RETENTION_VISUALS } from './retentionStyle'

interface RetentionNoticeProps {
  info: RetentionInfo
}

export function RetentionNotice({ info }: RetentionNoticeProps) {
  const { t } = useTranslation()
  const visual = RETENTION_VISUALS[info.tier]
  const { Icon } = visual

  return (
    <XStack
      testID={`retention-notice-${info.tier}`}
      gap={8}
      padding={10}
      borderRadius={8}
      backgroundColor={visual.bg}
      borderWidth={1}
      borderColor={visual.border}
      alignItems="flex-start"
    >
      <Icon size={14} color={visual.fg} />
      <Text flex={1} fontSize={12} lineHeight={17} color={visual.fg}>
        {t(`dataRetention.notice.${info.noticeSlug}`)}
      </Text>
    </XStack>
  )
}
