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

import { useTranslation } from "react-i18next"
import { Linking, Platform, View } from "react-native"
import { Btn, Card, T, Tile } from "../ui/ds"

export interface PaymentDueWidgetProps {
  amount?: number
  currency?: string
  hostedInvoiceUrl?: string | null
}

export function PaymentDueWidget({ amount, currency, hostedInvoiceUrl }: PaymentDueWidgetProps) {
  const { t } = useTranslation()

  const openInvoice = () => {
    if (!hostedInvoiceUrl) return
    if (Platform.OS === "web") {
      window.open(hostedInvoiceUrl, "_blank", "noopener,noreferrer")
    } else {
      Linking.openURL(hostedInvoiceUrl)
    }
  }

  return (
    <View
      testID="payment-due-widget"
      style={{ marginVertical: 8, marginHorizontal: 8, maxWidth: 380, alignSelf: "flex-start" }}
    >
      <Card pad>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Tile tone="amber" size="sm" icon="credit-card" />
          <T step="base" style={{ flex: 1 }}>
            {t("billing.paymentDue.title")}
          </T>
        </View>

        <T step="sm" tone="text2" style={{ marginTop: 10 }}>
          {t("billing.paymentDue.hint")}
        </T>

        {typeof amount === "number" && amount > 0 && (
          <T testID="payment-due-amount" step="xl" style={{ marginTop: 12 }}>
            {amount} {currency ?? "EUR"}
          </T>
        )}

        <View style={{ marginTop: 14, alignItems: "flex-start" }}>
          {/* THE CTA: regularize the overdue payment. */}
          {hostedInvoiceUrl ? (
            <Btn
              testID="payment-due-cta"
              variant="primary"
              size="sm"
              icon="arrow-square-out"
              onPress={openInvoice}
            >
              {t("billing.paymentDue.regularize")}
            </Btn>
          ) : (
            <T step="12" tone="text3">
              {t("billing.paymentDue.contact")}
            </T>
          )}
        </View>
      </Card>
    </View>
  )
}
