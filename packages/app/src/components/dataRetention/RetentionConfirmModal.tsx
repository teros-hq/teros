/**
 * RetentionConfirmModal — blocking confirmation dialog shown when the user
 * picks a 🔴 model/provider (trains on your data by default, or opaque policy).
 *
 * Makes the data-retention choice a conscious one: the user must either back
 * out ("choose another") or explicitly accept ("use anyway"). Paired with
 * useRetentionGuard, which decides when to open it and remembers the choice.
 */

import { useTranslation } from 'react-i18next'
import { Button, Dialog, Paragraph, Text, XStack } from 'tamagui'
import { RETENTION_VERIFIED_AT, type RetentionInfo } from '@teros/shared'
import { RETENTION_VISUALS } from './retentionStyle'

interface RetentionConfirmModalProps {
  open: boolean
  /** Posture of the model being confirmed (null when closed). */
  info: RetentionInfo | null
  /** Display name of the model/provider, shown under the title. */
  modelName?: string
  onConfirm: () => void
  onCancel: () => void
}

export function RetentionConfirmModal({
  open,
  info,
  modelName,
  onConfirm,
  onCancel,
}: RetentionConfirmModalProps) {
  const { t } = useTranslation()
  const visual = RETENTION_VISUALS[info?.tier ?? 'trains']
  const Icon = visual.Icon

  return (
    <Dialog modal open={open} onOpenChange={(o) => (!o ? onCancel() : null)}>
      <Dialog.Portal>
        <Dialog.Overlay
          key="overlay"
          animation="card"
          opacity={0.5}
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content"
          testID="retention-confirm-modal"
          bordered
          elevate
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={460}
          maxWidth="90%"
          padding="$5"
          gap="$4"
        >
          <XStack gap="$3" alignItems="center">
            <Icon size={22} color={visual.fg} />
            <Dialog.Title fontWeight="700" fontSize="$6" color={visual.fg}>
              {t('dataRetention.modal.title')}
            </Dialog.Title>
          </XStack>
          {modelName ? (
            <Text fontSize="$3" fontWeight="600" color="$gray11" marginTop="$-2">
              {modelName}
            </Text>
          ) : null}
          <Paragraph fontSize="$3" lineHeight="$2">
            {info ? t(`dataRetention.notice.${info.noticeSlug}`) : ''}
          </Paragraph>
          <XStack gap="$3" justifyContent="flex-end">
            {/* Not wrapped in Dialog.Close: onCancel already closes via state,
                and the Close wrapper would fire onOpenChange → onCancel twice. */}
            <Button size="$3" testID="retention-confirm-cancel" onPress={onCancel}>
              {t('dataRetention.modal.cancel')}
            </Button>
            <Button size="$3" theme="red" testID="retention-confirm-accept" onPress={onConfirm}>
              {t('dataRetention.modal.confirm')}
            </Button>
          </XStack>
          <Text fontSize="$1" color="$gray9">
            {t('dataRetention.modal.verifiedAt', { date: RETENTION_VERIFIED_AT })}
          </Text>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
