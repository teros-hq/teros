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
// `/pure`: the default entry injects js.stripe.com at IMPORT time; the pure
// entry loads it only when loadStripe() runs (the card form), so the app
// boots without touching the internet.
import type { Stripe } from "@stripe/stripe-js"
import { loadStripe } from "@stripe/stripe-js/pure"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useColors, useMcaTheme } from "../mca/primitives/useColors"
import { colors as semantic } from "../mca/primitives/colors"
import { FONT_SANS } from "../mca/primitives/fonts"
import { Btn, Field, FieldHelp, FieldLabel, T } from "../ui/ds"
import { Select } from "../../windows/UsersWindow/Select"

/**
 * Countries offered for the tax location. ISO-3166-1 alpha-2 → label. Kept
 * short on purpose (where Teros sells); the backend accepts any alpha-2 code.
 */
export const BILLING_COUNTRIES: Array<{ key: string; label: string }> = [
  { key: "ES", label: "España" },
  { key: "PT", label: "Portugal" },
  { key: "FR", label: "France" },
  { key: "DE", label: "Deutschland" },
  { key: "IT", label: "Italia" },
  { key: "NL", label: "Nederland" },
  { key: "BE", label: "Belgique" },
  { key: "IE", label: "Ireland" },
  { key: "AT", label: "Österreich" },
  { key: "PL", label: "Polska" },
  { key: "SE", label: "Sverige" },
  { key: "DK", label: "Danmark" },
  { key: "FI", label: "Suomi" },
  { key: "GB", label: "United Kingdom" },
  { key: "CH", label: "Schweiz" },
  { key: "NO", label: "Norge" },
  { key: "US", label: "United States" },
  { key: "CA", label: "Canada" },
  { key: "MX", label: "México" },
  { key: "AR", label: "Argentina" },
  { key: "CL", label: "Chile" },
  { key: "CO", label: "Colombia" },
  { key: "BR", label: "Brasil" },
]

/** Stripe tax id type for a country's business tax number (VAT / CIF / EIN…). */
export function taxIdTypeFor(country: string): string {
  const EU = new Set(["ES", "PT", "FR", "DE", "IT", "NL", "BE", "IE", "AT", "PL", "SE", "DK", "FI"])
  if (EU.has(country)) return "eu_vat"
  switch (country) {
    case "GB": return "gb_vat"
    case "CH": return "ch_vat"
    case "NO": return "no_vat"
    case "US": return "us_ein"
    case "CA": return "ca_bn"
    case "MX": return "mx_rfc"
    case "AR": return "ar_cuit"
    case "CL": return "cl_tin"
    case "CO": return "co_nit"
    case "BR": return "br_cnpj"
    default: return "eu_vat"
  }
}

interface PaymentMethodSetupProps {
  /** Called after the card is vaulted as the default (set-payment-method OK). */
  onSuccess: () => void
  onCancel: () => void
  /** Tax location already on file, to prefill the country / tax id fields. */
  initialDetails?: { country: string | null; taxId: string | null } | null
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
      colorPrimary: semantic.purple300,
      colorBackground: c.bgStep,
      colorText: c.text,
      borderRadius: "10px",
      fontFamily: `${FONT_SANS}, system-ui, sans-serif`,
    },
  }
}

// ── Inner form (inside <Elements>, so the Stripe hooks resolve) ─────────────────

function CardForm({ onSuccess, onCancel, initialDetails }: PaymentMethodSetupProps) {
  const { t } = useTranslation()
  const stripe = useStripe()
  const elements = useElements()
  const client = getTerosClient()

  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [country, setCountry] = useState<string>(initialDetails?.country ?? "ES")
  const [taxId, setTaxId] = useState<string>(initialDetails?.taxId ?? "")

  const handleSave = useCallback(async () => {
    if (!stripe || !elements || processing) return
    setProcessing(true)
    setError(null)

    // 0) Tax location first: Stripe Tax needs the customer's country BEFORE any
    //    invoice, and the card may redirect away (3DS) right after this.
    //    Best-effort: a failure here must not block vaulting the card.
    try {
      await client.billing.setBillingDetails({
        country,
        taxId: taxId.trim() || null,
        taxIdType: taxId.trim() ? taxIdTypeFor(country) : null,
      })
    } catch (err) {
      console.warn("[PaymentMethodSetup] setBillingDetails failed:", err)
    }

    // 1) Vault the card via the SetupIntent. redirect:'if_required' keeps cards
    //    inline; a return_url is still required for redirect-based methods. When
    //    the bank requires 3DS, Stripe redirects and the return is finished by
    //    `useStripeSetupReturn` (billing.complete-setup-intent).
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
    <View testID="payment-method-form" style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        <View style={{ minWidth: 180 }}>
          <FieldLabel>{t("profile.plan.payment.countryLabel", { defaultValue: "País de facturación" })}</FieldLabel>
          <Select
            testID="payment-method-country"
            value={country}
            options={BILLING_COUNTRIES}
            onChange={setCountry}
            minWidth={180}
            ariaLabel={t("profile.plan.payment.countryLabel", { defaultValue: "País de facturación" })}
          />
        </View>
        <View style={{ flex: 1, minWidth: 180 }}>
          <FieldLabel>{t("profile.plan.payment.taxIdLabel", { defaultValue: "NIF / IVA (opcional)" })}</FieldLabel>
          <Field
            value={taxId}
            onChangeText={setTaxId}
            placeholder={t("profile.plan.payment.taxIdPlaceholder", { defaultValue: "ESB12345678" })}
            editable={!processing}
            autoCapitalize="characters"
            testID="payment-method-tax-id"
          />
          <FieldHelp>{t("profile.plan.payment.taxIdHint", { defaultValue: "Aparece en la factura y aplica el IVA que corresponda." })}</FieldHelp>
        </View>
      </View>
      <View>
        <FieldLabel>{t("profile.plan.payment.cardLabel", { defaultValue: "Tarjeta" })}</FieldLabel>
        <View testID="payment-element">
          <PaymentElement options={{ layout: "tabs" }} />
        </View>
        {error ? (
          <T testID="payment-method-error" step="12" tone="danger" style={{ marginTop: 8 }}>
            {error}
          </T>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {/* Outlined: cancel is the retreat. */}
        <Btn
          testID="payment-method-cancel"
          variant="sec"
          style={{ flex: 1 }}
          onPress={onCancel}
          disabled={processing}
        >
          {t("profile.plan.payment.cancel")}
        </Btn>
        {/* THE CTA: vault the card. */}
        <Btn
          testID="payment-method-save"
          variant="primary"
          icon="credit-card"
          style={{ flex: 1 }}
          onPress={handleSave}
          disabled={!stripe || !elements || processing}
          loading={processing}
        >
          {processing ? t("profile.plan.payment.saving") : t("profile.plan.payment.save")}
        </Btn>
      </View>
    </View>
  )
}

// ── Outer: mints the SetupIntent + loads Stripe.js, then mounts <Elements> ──────

export function PaymentMethodSetup({ onSuccess, onCancel, initialDetails }: PaymentMethodSetupProps) {
  const { t } = useTranslation()
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
      <T testID="payment-method-loading" step="sm" tone="text3" style={{ paddingVertical: 12 }}>
        {t("profile.plan.payment.loading")}
      </T>
    )
  }

  if (initError || !clientSecret || !stripePromise) {
    return (
      <View style={{ gap: 12, paddingVertical: 4 }}>
        <T testID="payment-method-init-error" step="sm" tone="danger">
          {initError || t("profile.plan.payment.initError")}
        </T>
        <Btn variant="sec" onPress={onCancel} style={{ alignSelf: "flex-start" }}>
          {t("profile.plan.payment.cancel")}
        </Btn>
      </View>
    )
  }

  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
      <CardForm onSuccess={onSuccess} onCancel={onCancel} initialDetails={initialDetails} />
    </Elements>
  )
}
