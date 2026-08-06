/**
 * PaymentMethodSetup — reusable Stripe card-capture form (TER-596 I3).
 *
 * Vaults a payment method as the caller's default, without touching the plan:
 *
 *   create-setup-intent → confirmSetup (Stripe.js) → set-payment-method
 *
 * It owns its own Save/Cancel buttons and only updates the default card (it does
 * NOT change the plan) — used from the profile "Plan" section to add/replace it.
 * Stripe Elements is web/PWA only; native shows an unavailable notice.
 */

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe, type Stripe } from "@stripe/stripe-js"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform } from "react-native"
import { Button, Text, XStack, YStack } from "tamagui"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useColors, useMcaTheme } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"

const ACCENT = "#06B6D4"

interface PaymentMethodSetupProps {
  /** Called after the card is vaulted as the default (set-payment-method OK). */
  onSuccess: () => void
  onCancel: () => void
}

/**
 * Build a Stripe Elements appearance object from the active design-system theme.
 * Stripe supports two built-in themes: "night" (dark) and "stripe" (light).
 * We map our surface/text tokens onto Stripe's CSS variables so the card form
 * matches the surrounding UI in both light and dark mode.
 */
function useStripeAppearance() {
  const c = useColors()
  const theme = useMcaTheme()
  return {
    theme: (theme === "dark" ? "night" : "stripe") as "night" | "stripe",
    variables: {
      colorPrimary: ACCENT,
      colorBackground: c.bgCard,
      colorText: c.text,
      borderRadius: "8px",
      fontFamily: "Inter, system-ui, sans-serif",
    },
  }
}

// ── Inner form (inside <Elements>, so the Stripe hooks resolve) ─────────────────

function CardForm({ onSuccess, onCancel }: PaymentMethodSetupProps) {
  const { t } = useTranslation()
  const c = useColors()
  const stripe = useStripe()
  const elements = useElements()
  const client = getTerosClient()

  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = useCallback(async () => {
    if (!stripe || !elements || processing) return
    setProcessing(true)
    setError(null)

    // 1) Vault the card via the SetupIntent. redirect:'if_required' keeps cards
    //    inline; a return_url is still required for redirect-based methods.
    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    })
    if (confirmError) {
      setProcessing(false)
      setError(confirmError.message || t("profile.plan.payment.error"))
      return
    }
    const rawPm = setupIntent?.payment_method
    const paymentMethodId = typeof rawPm === "string" ? rawPm : (rawPm?.id ?? null)
    if (!paymentMethodId) {
      setProcessing(false)
      setError(t("profile.plan.payment.error"))
      return
    }

    // 2) Store it as the default. Toasts + refetch are the parent's job.
    try {
      await client.billing.setPaymentMethod(paymentMethodId)
    } catch (err: any) {
      setProcessing(false)
      setError(err?.message || t("profile.plan.payment.error"))
      return
    }
    setProcessing(false)
    onSuccess()
  }, [stripe, elements, processing, client, onSuccess, t])

  return (
    <YStack gap={14} testID="payment-method-form">
      <YStack testID="payment-element">
        <PaymentElement options={{ layout: "tabs" }} />
      </YStack>
      {error && (
        <Text testID="payment-method-error" fontSize={12} color={semanticColors.red} lineHeight={17}>
          {error}
        </Text>
      )}
      <XStack gap={10}>
        <Button
          flex={1}
          height={44}
          backgroundColor={c.bgInner}
          borderWidth={1}
          borderColor={c.border}
          borderRadius={10}
          pressStyle={{ backgroundColor: c.bgCardHover }}
          onPress={onCancel}
          disabled={processing}
        >
          <Text color={c.text2} fontSize={14} fontWeight="500">
            {t("profile.plan.payment.cancel")}
          </Text>
        </Button>
        <Button
          testID="payment-method-save"
          flex={1}
          height={44}
          backgroundColor="rgba(6, 182, 212, 0.15)"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.35)"
          borderRadius={10}
          pressStyle={{ backgroundColor: "rgba(6, 182, 212, 0.25)" }}
          onPress={handleSave}
          disabled={!stripe || !elements || processing}
        >
          <Text color={ACCENT} fontSize={14} fontWeight="600">
            {processing ? t("profile.plan.payment.saving") : t("profile.plan.payment.save")}
          </Text>
        </Button>
      </XStack>
    </YStack>
  )
}

// ── Outer: mints the SetupIntent + loads Stripe.js, then mounts <Elements> ──────

export function PaymentMethodSetup({ onSuccess, onCancel }: PaymentMethodSetupProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const appearance = useStripeAppearance()

  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null)
  const [loading, setLoading] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)

  const init = useCallback(async () => {
    if (Platform.OS !== "web") {
      setLoading(false)
      setInitError(t("profile.plan.payment.unavailable"))
      return
    }
    setLoading(true)
    setInitError(null)
    try {
      const { clientSecret: secret, publishableKey } = await client.billing.createSetupIntent()
      if (!publishableKey || !secret) {
        setInitError(t("profile.plan.payment.unavailable"))
        return
      }
      setClientSecret(secret)
      setStripePromise(loadStripe(publishableKey))
    } catch (err: any) {
      setInitError(err?.message || t("profile.plan.payment.initError"))
    } finally {
      setLoading(false)
    }
    // client is a stable module singleton — intentionally not a dependency.
  }, [t])

  useEffect(() => {
    init()
  }, [init])

  if (loading) {
    return (
      <Text testID="payment-method-loading" fontSize={13} color={c.text3} paddingVertical={12}>
        {t("profile.plan.payment.loading")}
      </Text>
    )
  }

  if (initError || !clientSecret || !stripePromise) {
    return (
      <YStack gap={10} paddingVertical={4}>
        <Text testID="payment-method-init-error" fontSize={13} color={semanticColors.red} lineHeight={19}>
          {initError || t("profile.plan.payment.initError")}
        </Text>
        <Button
          alignSelf="flex-start"
          height={40}
          paddingHorizontal={16}
          backgroundColor={c.bgInner}
          borderWidth={1}
          borderColor={c.border}
          borderRadius={10}
          onPress={onCancel}
        >
          <Text color={c.text2} fontSize={14}>
            {t("profile.plan.payment.cancel")}
          </Text>
        </Button>
      </YStack>
    )
  }

  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
      <CardForm onSuccess={onSuccess} onCancel={onCancel} />
    </Elements>
  )
}
