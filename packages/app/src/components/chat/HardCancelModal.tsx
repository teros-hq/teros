import React from 'react';
import { Button, Dialog, Paragraph, XStack, YStack } from 'tamagui';
import { t } from '../../lib/i18n';

interface HardCancelModalProps {
  open: boolean;
  hasIrreversibleToolInFlight?: boolean;
  irreversibleToolName?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function HardCancelModal({
  open,
  hasIrreversibleToolInFlight = false,
  irreversibleToolName,
  onConfirm,
  onCancel,
}: HardCancelModalProps): React.ReactElement {
  const body = hasIrreversibleToolInFlight
    ? t('chat.stop.hardConfirm.bodyWithIrreversible', {
        toolName: irreversibleToolName ?? 'tool',
      })
    : t('chat.stop.hardConfirm.bodyNoIrreversible');

  const confirmLabel = hasIrreversibleToolInFlight
    ? t('chat.stop.hardConfirm.confirmWait')
    : t('chat.stop.hardConfirm.confirm');

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
          bordered
          elevate
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={460}
          padding="$5"
          gap="$4"
        >
          <Dialog.Title fontWeight="600" fontSize="$6">
            {t('chat.stop.hardConfirm.title')}
          </Dialog.Title>
          <YStack gap="$3">
            <Paragraph fontSize="$3" lineHeight="$2">
              {body}
            </Paragraph>
          </YStack>
          <XStack gap="$3" justifyContent="flex-end">
            <Dialog.Close asChild>
              <Button size="$3" onPress={onCancel}>
                {t('chat.stop.hardConfirm.deny')}
              </Button>
            </Dialog.Close>
            <Button
              size="$3"
              theme="red"
              onPress={onConfirm}
            >
              {confirmLabel}
            </Button>
          </XStack>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
