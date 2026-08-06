/**
 * PaymentDueWidget — the transversal hard-block CTA shown inside the chat
 * ErrorBlock when a turn is rejected with PaymentDueError (FASE 9, decision B).
 *
 * The backend propagates the block as a chat error message with errorType
 * 'upgrade_required' and context { reason:'payment_due', amount, currency,
 * hostedInvoiceUrl } (agent-loop.ts). ErrorBlock special-cases it and renders
 * this widget. Unlike the hours block, this one cuts EVERY provider (including
 * BYOK) — the only way out is to regularize the payment. When a Stripe hosted
 * invoice URL is available we link straight to it; otherwise we point the user
 * to support (BETA has no Stripe → no hosted URL).
 */

import { useTranslation } from 'react-i18next'
import { Platform, Linking } from 'react-native'
import { Button, Text, XStack, YStack } from 'tamagui'
import { AlertTriangle } from '@tamagui/lucide-icons'
import { useColors } from '../mca/primitives/useColors'
import { colors as semanticColors, indicators } from '../mca/primitives/colors'

const ACCENT = '#06B6D4'

export interface PaymentDueWidgetProps {
  amount?: number
  currency?: string
  hostedInvoiceUrl?: string | null
}

export function PaymentDueWidget({ amount, currency, hostedInvoiceUrl }: PaymentDueWidgetProps) {
  const { t } = useTranslation()
  const c = useColors()

  const openInvoice = () => {
    if (!hostedInvoiceUrl) return
    if (Platform.OS === 'web') {
      window.open(hostedInvoiceUrl, '_blank', 'noopener,noreferrer')
    } else {
      Linking.openURL(hostedInvoiceUrl)
    }
  }

  return (
    <YStack
      testID="payment-due-widget"
      backgroundColor={c.bgInner}
      borderColor={indicators.irreversible.border}
      borderWidth={1}
      borderRadius="$3"
      padding="$3"
      marginVertical="$2"
      marginHorizontal="$2"
      maxWidth={380}
      alignSelf="flex-start"
      gap="$2"
    >
      <XStack alignItems="center" gap="$2">
        <AlertTriangle size={16} color={semanticColors.red} />
        <Text color={c.text} fontWeight="600" fontSize="$3">
          {t('billing.paymentDue.title')}
        </Text>
      </XStack>

      <Text color={c.text2} fontSize="$2" lineHeight="$4">
        {t('billing.paymentDue.hint')}
      </Text>

      {typeof amount === 'number' && amount > 0 && (
        <Text testID="payment-due-amount" color={c.text2} fontSize="$2">
          {amount} {currency ?? 'EUR'}
        </Text>
      )}

      {hostedInvoiceUrl ? (
        <Button
          testID="payment-due-cta"
          size="$2"
          backgroundColor={ACCENT}
          color={c.bgPage}
          fontWeight="600"
          alignSelf="flex-start"
          onPress={openInvoice}
        >
          {t('billing.paymentDue.regularize')}
        </Button>
      ) : (
        <Text color={c.text3} fontSize="$1">
          {t('billing.paymentDue.contact')}
        </Text>
      )}
    </YStack>
  )
}
