/**
 * WebhookUrlDialog — shows a freshly minted webhook URL exactly once.
 *
 * In-window overlay (same scrim + sheet as ConfirmDialog, never a fixed
 * element escaping the tiling layout): warning line, the URL in a mono box,
 * a Copy pill and a Done pill. Esc closes.
 */

import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, View } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { useColors } from '../../components/mca/primitives/useColors'
import { Btn, Ph, T } from '../../components/ui/ds'
import { useScrimColor, useSheetWeb } from '../UsersWindow/detail/ConfirmDialog'

export interface WebhookUrlDialogProps {
  url: string | null
  onClose: () => void
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through
  }
  return false
}

export function WebhookUrlDialog({ url, onClose }: WebhookUrlDialogProps) {
  const { t } = useTranslation()
  const c = useColors()
  const scrim = useScrimColor()
  const sheetWeb = useSheetWeb()
  const dialogRef = useRef<{ focus?: () => void } | null>(null)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')

  useEffect(() => {
    if (url) {
      setCopied('idle')
      dialogRef.current?.focus?.()
    }
  }, [url])

  if (!url) return null

  const handleCopy = async () => {
    const ok = await copyToClipboard(url)
    setCopied(ok ? 'ok' : 'fail')
    if (ok) setTimeout(() => setCopied('idle'), 2000)
  }

  return (
    <YStack
      testID="webhook-url-dialog"
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      ai="center"
      jc="center"
      padding={24}
      zIndex={1000}
      backgroundColor={scrim}
      onPress={onClose}
    >
      <YStack
        ref={dialogRef as never}
        width="100%"
        maxWidth={520}
        gap={14}
        padding={20}
        borderRadius={16}
        backgroundColor={c.bgStep}
        onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
        {...sheetWeb}
        {...({
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('automate.url.title', { defaultValue: 'Webhook URL' }),
          tabIndex: -1,
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Escape') onClose()
          },
        } as Record<string, unknown>)}
      >
        <T step="xl">{t('automate.url.title', { defaultValue: 'Webhook URL' })}</T>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            padding: 10,
            paddingHorizontal: 12,
            borderRadius: 10,
            backgroundColor: c.tint.a.bg,
            borderWidth: 1,
            borderColor: c.tint.a.bd,
          }}
        >
          <Ph name="warning" size={14} color={c.tint.a.tx} />
          <T step="12" color={c.tint.a.tx} style={{ flex: 1 }}>
            {t('automate.url.warning', {
              defaultValue: 'This URL is shown only once. Copy it now — regenerating it later replaces it.',
            })}
          </T>
        </View>

        <View
          style={{
            padding: 12,
            borderRadius: 10,
            backgroundColor: c.field,
            borderWidth: 1,
            borderColor: c.border,
          }}
        >
          <T step="code" selectable style={Platform.OS === 'web' ? ({ wordBreak: 'break-all' } as any) : undefined}>
            {url}
          </T>
        </View>

        {copied === 'fail' ? (
          <T step="12" tone="danger">
            {t('automate.url.copyFailed', { defaultValue: 'Clipboard unavailable — select the URL and copy it manually.' })}
          </T>
        ) : null}

        <XStack gap={8} jc="flex-end" ai="center" paddingTop={4}>
          <Btn variant="ghost" onPress={onClose} testID="webhook-url-done">
            {t('automate.url.done', { defaultValue: 'Done' })}
          </Btn>
          <Btn
            variant="primary"
            icon={copied === 'ok' ? 'check' : 'copy'}
            onPress={handleCopy}
            testID="webhook-url-copy"
          >
            {copied === 'ok'
              ? t('common.copied', { defaultValue: 'Copied' })
              : t('common.copy', { defaultValue: 'Copy' })}
          </Btn>
        </XStack>
      </YStack>
    </YStack>
  )
}
