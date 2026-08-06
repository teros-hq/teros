/**
 * ProfilePlanSection — the profile "Plan & billing" screen (TER-596 I3).
 *
 * Self-serve view of the caller's OWN subscription, rendered as a third mode of
 * ProfileWindowContent (alongside view/edit). Consumes the user-facing billing
 * API (get-subscription [+ default card] / list-plans / get-invoices /
 * preview-plan-change / change-plan + the Stripe setup-intent flow). Layout:
 *   - a usage HERO (plan + big usage bar + hours left + renewal/reset);
 *   - comparable PRICING CARDS (price, hours, highlights, Popular/Current badge,
 *     Upgrade/Downgrade CTA) — picking one previews the real prorated charge;
 *   - the default payment method (brand ···· last4 · exp) + change;
 *   - invoice history with hosted-page + PDF links.
 *
 * Backend returns DATA (ids + resolved names + amounts); this composes the copy.
 * a11y: all body copy ≥ #A1A1AA (8.19:1 on black, WCAG 1.4.3 AA); link targets
 * ≥ 24px (WCAG 2.5.8).
 */

import {
  ArrowLeft,
  Check,
  CheckCircle,
  CreditCard,
  ExternalLink,
  FileText,
  Infinity as InfinityIcon,
  Receipt,
} from "@tamagui/lucide-icons"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Linking, Platform, ScrollView } from "react-native"
import { Button, Text, View, XStack, YStack } from "tamagui"
import { PaymentMethodSetup } from "../../components/billing/PaymentMethodSetup"
import { installUnlimitedGlareKeyframes } from "./unlimitedGlareKeyframes"
import { useToast } from "../../components/Toast"
import { AppSpinner } from "../../components/ui"
import i18n from "../../i18n"
import type {
  BillingPlanView,
  InvoiceView,
  PaymentMethodView,
  PlanChangePreview,
  SubscriptionView,
} from "../../services/BillingApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors } from "../../components/mca/primitives/colors"

const SALES_CONTACT_URL = "mailto:sales@teros.ai"

// Brand accent — no semantic token equivalent (theme-agnostic cyan)
const ACCENT = "#06B6D4"
const RED = semanticColors.red
const GREEN = semanticColors.green
const AMBER = semanticColors.amber

// ── Formatting helpers (data → copy) ────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(i18n.language, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

/** `amount`/`price` are major units (EUR), not cents — see toStripeAmount. */
function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(i18n.language, { style: "currency", currency }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000))
}

/** A fresh idempotency token, guarded for runtimes without crypto.randomUUID. */
function newReqId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// A deterministic payment failure means "retry, maybe with another card" → mint a
// fresh token. An indeterminate/transport error keeps the token so a blind retry
// reuses the same invoice (no double-charge). Backend HandlerError codes.
const PAYMENT_FAILURE_CODES = [
  "CARD_DECLINED",
  "INSUFFICIENT_FUNDS",
  "EXPIRED_CARD",
  "AUTH_REQUIRED",
  "NO_PAYMENT_METHOD",
  "PAYMENT_FAILED",
]
function isDeterministicPaymentFailure(err: unknown): boolean {
  const tag = String((err as any)?.code ?? (err as any)?.message ?? "")
  return PAYMENT_FAILURE_CODES.some((c) => tag.includes(c))
}

// ── Status / tone pill ───────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "danger" | "muted"

// Semantic tones — theme-agnostic (same hex in light and dark).
// The muted tone is resolved at render time via useColors() since it uses
// surface text tokens.
const TONE_STYLES: Record<Tone, { fg: string; bg: string; border: string }> = {
  ok: { fg: GREEN, bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.3)" },
  warn: { fg: AMBER, bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)" },
  danger: { fg: RED, bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)" },
  muted: { fg: "", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)" },
}

function Pill({ label, tone, testID }: { label: string; tone: Tone; testID?: string }) {
  const c = useColors()
  const s = TONE_STYLES[tone]
  // Muted tone uses theme-adaptive text color; others are semantic (theme-agnostic)
  const fg = tone === "muted" ? c.text2 : s.fg
  const bg = tone === "muted" ? c.badges.gray.bg : s.bg
  const border = tone === "muted" ? c.badges.gray.border : s.border
  return (
    <YStack
      testID={testID}
      paddingHorizontal={8}
      paddingVertical={3}
      borderRadius={6}
      backgroundColor={bg}
      borderWidth={1}
      borderColor={border}
    >
      <Text fontSize={10} fontWeight="700" color={fg} letterSpacing={0.4}>
        {label}
      </Text>
    </YStack>
  )
}

const INVOICE_TONE: Record<InvoiceView["status"], Tone> = {
  paid: "ok",
  waived: "muted",
  pending: "muted",
  invoiced: "warn",
  overdue: "warn",
  uncollectible: "danger",
}

function SectionHeading({ icon, label }: { icon: React.ReactNode; label: string }) {
  const c = useColors()
  return (
    <XStack alignItems="center" gap={8} marginBottom={12}>
      {icon}
      <Text fontSize={12} color={c.text2} textTransform="uppercase" letterSpacing={1}>
        {label}
      </Text>
    </XStack>
  )
}

// ── Usage hero (the active plan + consumption, the #1 question) ──────────────────

function UsageHero({ sub }: { sub: SubscriptionView }) {
  const { t } = useTranslation()
  const c = useColors()
  // The hidden Unlimited tier gets a distinct chrome-metallic hero (TER-638) —
  // only its holders ever see it; everyone else falls through to the default.
  if (sub.planId === "plan_unlimited") return <UnlimitedHero sub={sub} />
  const metered = sub.terosModel && sub.agentHoursLimit > 0
  const unmetered = sub.terosModel && sub.agentHoursLimit === 0
  const pct = metered ? Math.min(sub.agentHoursUsed / sub.agentHoursLimit, 1) : 0
  const left = Math.max(0, Math.round((sub.agentHoursLimit - sub.agentHoursUsed) * 10) / 10)
  const barColor = pct >= 1 ? RED : pct >= 0.8 ? AMBER : ACCENT

  const statusTone: Tone =
    sub.status === "active" ? "ok" : sub.status === "past_due" ? "danger" : "warn"
  const priceLabel =
    sub.price === 0
      ? t("profile.plan.priceFree")
      : t("profile.plan.priceMonthly", { price: formatMoney(sub.price, sub.currency) })

  return (
    <YStack
      testID="plan-hero"
      backgroundColor="rgba(6,182,212,0.06)"
      borderWidth={1}
      borderColor="rgba(6,182,212,0.22)"
      borderRadius={16}
      padding={20}
      gap={16}
    >
      <XStack alignItems="center" gap={10} flexWrap="wrap">
        <Text fontSize={22} fontWeight="800" color={c.text}>
          {sub.planName}
        </Text>
        <Pill
          label={t(`profile.plan.status.${sub.status}`)}
          tone={statusTone}
          testID="plan-status"
        />
        <YStack flex={1} />
        <Text fontSize={14} fontWeight="600" color={c.text2}>
          {priceLabel}
        </Text>
      </XStack>

      {metered ? (
        <YStack gap={8}>
          <XStack alignItems="flex-end" justifyContent="space-between">
            <Text fontSize={26} fontWeight="800" color={c.text}>
              {t("profile.plan.hoursLeft", { hours: left })}
            </Text>
            <Text fontSize={13} color={c.text2}>
              {t("profile.plan.usedOfLimit", {
                used: Math.round(sub.agentHoursUsed * 10) / 10,
                limit: sub.agentHoursLimit,
              })}
            </Text>
          </XStack>
          <YStack
            testID="usage-bar"
            height={12}
            borderRadius={6}
            backgroundColor={c.borderStrong}
            overflow="hidden"
          >
            <YStack
              height={12}
              width={`${pct * 100}%`}
              backgroundColor={barColor}
              borderRadius={6}
            />
          </YStack>
          {sub.boostHours > 0 && (
            <Text fontSize={12} color={ACCENT}>
              {t("profile.plan.boostIncluded", { hours: sub.boostHours })}
            </Text>
          )}
        </YStack>
      ) : (
        <Text fontSize={15} color={c.text}>
          {unmetered ? t("profile.plan.hoursUnmetered") : t("profile.plan.hoursByok")}
        </Text>
      )}

      <XStack alignItems="center" gap={8} flexWrap="wrap">
        <Text fontSize={13} color={c.text2}>
          {sub.cancelAtPeriodEnd
            ? t("profile.plan.endsOn", { date: formatDate(sub.currentPeriodEnd) })
            : t("profile.plan.renewsInDays", {
                date: formatDate(sub.currentPeriodEnd),
                days: daysUntil(sub.currentPeriodEnd),
              })}
        </Text>
        {sub.scheduledPlanChange && (
          <Pill
            testID="scheduled-change"
            tone="warn"
            label={t("profile.plan.scheduledChange", {
              plan: sub.scheduledPlanChange.planName,
              // The downgrade applies at the period end (reset-cron), NOT at
              // scheduledAt (= when it was queued, i.e. "now"). Review M2.
              date: formatDate(sub.currentPeriodEnd),
            })}
          />
        )}
        {sub.cancelAtPeriodEnd && (
          <Pill testID="cancel-scheduled" tone="danger" label={t("profile.plan.cancelScheduled")} />
        )}
      </XStack>
    </YStack>
  )
}

// ── Unlimited hero (chrome-metallic, glare sweep) — only plan_unlimited holders ──

/**
 * Premium treatment for the hidden internal Unlimited tier: a polished
 * graphite→silver→graphite metallic panel with a diagonal light glare that
 * sweeps across it. Gated by the caller to plan_unlimited only. The sweep is a
 * CSS-keyframes overlay (web) that honours prefers-reduced-motion; native falls
 * back to a static faint highlight.
 */
function UnlimitedHero({ sub }: { sub: SubscriptionView }) {
  const { t } = useTranslation()
  const c = useColors()
  useEffect(() => {
    installUnlimitedGlareKeyframes()
  }, [])

  const statusTone: Tone =
    sub.status === "active" ? "ok" : sub.status === "past_due" ? "danger" : "warn"

  // Reduce-motion: pin the glare sweep off (static highlight stays).
  const reduceMotion =
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches

  // Polished-metal base: a web CSS gradient (native falls back to solid graphite).
  // Kept as a CSS background instead of expo-linear-gradient so the render harness
  // can parse it and the effect stays web-first like the glare.
  const metalStyle =
    Platform.OS === "web"
      ? ({
          background:
            "linear-gradient(135deg, #0f1115 0%, #2a2f3a 32%, #c2cad8 50%, #2a2f3a 68%, #0f1115 100%)",
        } as object)
      : { backgroundColor: "#2a2f3a" }

  const glareStyle =
    Platform.OS === "web"
      ? ({
          background:
            "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.45) 50%, transparent 60%)",
          ...(reduceMotion
            ? {}
            : { animation: "teros-unlimited-glare 4.5s ease-in-out infinite" }),
        } as object)
      : { backgroundColor: "rgba(255,255,255,0.06)" }

  return (
    <YStack
      testID="plan-hero"
      position="relative"
      overflow="hidden"
      borderRadius={16}
      borderWidth={1}
      borderColor="rgba(214,221,235,0.45)"
      padding={20}
      gap={16}
    >
      {/* Polished-metal base. */}
      <View
        pointerEvents="none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, ...metalStyle }}
      />
      {/* Moving glare (mirrors the chat shimmer technique). */}
      <View
        testID="unlimited-glare"
        pointerEvents="none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, ...glareStyle }}
      />

      {/* Content above the metallic layers. */}
      <YStack zIndex={1} gap={14}>
        <XStack alignItems="center" gap={10} flexWrap="wrap">
          <InfinityIcon size={22} color={c.text} />
          <Text fontSize={22} fontWeight="800" color={c.text}>
            {sub.planName}
          </Text>
          <Pill label={t(`profile.plan.status.${sub.status}`)} tone={statusTone} testID="plan-status" />
        </XStack>
        <Text testID="unlimited-tagline" fontSize={15} fontWeight="700" color={c.text}>
          {t("profile.plan.hoursUnmetered")}
        </Text>
        <Text fontSize={13} color={c.text2}>
          {sub.cancelAtPeriodEnd
            ? t("profile.plan.endsOn", { date: formatDate(sub.currentPeriodEnd) })
            : t("profile.plan.renewsInDays", {
                date: formatDate(sub.currentPeriodEnd),
                days: daysUntil(sub.currentPeriodEnd),
              })}
        </Text>
      </YStack>
    </YStack>
  )
}

// ── Pricing card (comparable, side-by-side) ──────────────────────────────────────

function priceText(plan: BillingPlanView, t: (k: string, o?: any) => string): string {
  if (plan.contactSales) return t("profile.plan.priceContact")
  if (plan.price === 0) return t("profile.plan.priceFree")
  return formatMoney(plan.price, plan.currency)
}

function PricingCard({
  plan,
  sub,
  busy,
  onSelect,
  onSales,
}: {
  plan: BillingPlanView
  sub: SubscriptionView
  busy: boolean
  onSelect: (plan: BillingPlanView) => void
  onSales: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  const isCurrent = plan.planId === sub.planId && !sub.scheduledPlanChange
  const cheaper = plan.price < sub.price
  const ctaLabel = plan.contactSales
    ? t("profile.plan.contactSales")
    : cheaper
      ? t("profile.plan.ctaDowngrade")
      : t("profile.plan.ctaUpgrade")

  return (
    <YStack
      testID={`pricing-card-${plan.planId}`}
      flexGrow={1}
      flexBasis={188}
      minWidth={172}
      padding={16}
      gap={10}
      borderRadius={12}
      backgroundColor={isCurrent ? "rgba(6,182,212,0.08)" : c.bgInner}
      borderWidth={1}
      borderColor={isCurrent ? "rgba(6,182,212,0.5)" : c.border}
    >
      <XStack alignItems="center" gap={6} flexWrap="wrap">
        <Text fontSize={15} fontWeight="700" color={c.text}>
          {plan.displayName}
        </Text>
        {plan.popular && <Pill label={t("profile.plan.popular")} tone="muted" />}
        {isCurrent && (
          <Pill
            testID={`current-badge-${plan.planId}`}
            label={t("profile.plan.current")}
            tone="ok"
          />
        )}
      </XStack>

      <XStack alignItems="baseline" gap={4}>
        <Text fontSize={22} fontWeight="800" color={c.text}>
          {priceText(plan, t)}
        </Text>
        {!plan.contactSales && plan.price > 0 && (
          <Text fontSize={12} color={c.text2}>
            {t("profile.plan.perMonth")}
          </Text>
        )}
      </XStack>

      <Text fontSize={12} color={c.text2}>
        {plan.contactSales || plan.agentHoursLimit === 0
          ? t("profile.plan.unmeteredShort")
          : t("profile.plan.hoursPerMonth", { hours: plan.agentHoursLimit })}
      </Text>

      {plan.highlights.slice(0, 4).map((h) => (
        <XStack key={h} gap={7} alignItems="flex-start">
          <Check size={13} color={ACCENT} style={{ marginTop: 2 }} />
          <Text fontSize={12} color={c.text2} flex={1} lineHeight={17}>
            {h}
          </Text>
        </XStack>
      ))}

      <YStack flex={1} />

      {isCurrent ? (
        <YStack
          testID={`cta-${plan.planId}`}
          height={40}
          borderRadius={10}
          backgroundColor={c.bgInner}
          alignItems="center"
          justifyContent="center"
        >
          <Text fontSize={13} fontWeight="600" color={c.text2}>
            {t("profile.plan.ctaCurrent")}
          </Text>
        </YStack>
      ) : (
        <Button
          testID={`cta-${plan.planId}`}
          height={40}
          borderRadius={10}
          backgroundColor={
            cheaper || plan.contactSales ? c.bgCardHover : "rgba(6,182,212,0.15)"
          }
          borderWidth={1}
          borderColor={
            cheaper || plan.contactSales ? c.borderStrong : "rgba(6,182,212,0.4)"
          }
          disabled={busy}
          onPress={() => (plan.contactSales ? onSales() : onSelect(plan))}
        >
          <Text
            fontSize={13}
            fontWeight="600"
            color={cheaper || plan.contactSales ? c.text : ACCENT}
          >
            {ctaLabel}
          </Text>
        </Button>
      )}
    </YStack>
  )
}

// ── Change confirmation with the real prorated quote ─────────────────────────────

function ChangeConfirm({
  plan,
  preview,
  loading,
  busy,
  card,
  onConfirm,
  onCancel,
  onCardAdded,
}: {
  plan: BillingPlanView
  preview: PlanChangePreview | null
  loading: boolean
  busy: boolean
  card: PaymentMethodView | null
  onConfirm: () => void
  onCancel: () => void
  onCardAdded: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()

  // A paid upgrade (proration > 0) charges the card immediately on confirm. With
  // no card vaulted, we must capture one FIRST — the backend refuses the upgrade
  // otherwise (TER-619). The confirm button is replaced by the card form until a
  // card exists, so the user can never trigger a charge that will be rejected.
  const isPaidUpgrade = preview?.kind === "upgrade" && preview.prorationAmount > 0
  const needsCard = isPaidUpgrade && !card

  let body: string
  if (loading || !preview) {
    body = t("profile.plan.checkingPreview")
  } else if (preview.kind === "downgrade") {
    body = t("profile.plan.previewDowngrade", {
      plan: preview.newPlanName,
      current: preview.currentPlanName,
      date: formatDate(preview.effectiveDate),
    })
  } else if (preview.prorationAmount > 0) {
    const amount = formatMoney(preview.prorationAmount, preview.currency)
    body = needsCard
      ? t("profile.plan.addCardForUpgrade", { amount })
      : t("profile.plan.previewUpgradeCharge", { amount })
  } else {
    body = t("profile.plan.previewUpgradeFree")
  }

  return (
    <YStack
      testID="change-confirm"
      marginTop={4}
      padding={16}
      borderRadius={12}
      backgroundColor="rgba(6,182,212,0.06)"
      borderWidth={1}
      borderColor="rgba(6,182,212,0.3)"
      gap={12}
    >
      <Text fontSize={15} fontWeight="700" color={c.text}>
        {t("profile.plan.confirmTitle", { plan: plan.displayName })}
      </Text>
      <Text testID="change-preview-amount" fontSize={13} color={c.text2} lineHeight={19}>
        {body}
      </Text>
      {needsCard ? (
        <YStack testID="change-needs-card" gap={10}>
          <PaymentMethodSetup onSuccess={onCardAdded} onCancel={onCancel} />
        </YStack>
      ) : (
        <XStack gap={10}>
          <Button
            flex={1}
            height={44}
            backgroundColor={c.bgInner}
            borderWidth={1}
            borderColor={c.borderStrong}
            borderRadius={10}
            disabled={busy}
            onPress={onCancel}
          >
            <Text color={c.text2} fontSize={14} fontWeight="500">
              {t("profile.plan.cancel")}
            </Text>
          </Button>
          <Button
            testID="change-confirm-apply"
            flex={1}
            height={44}
            backgroundColor="rgba(6,182,212,0.15)"
            borderWidth={1}
            borderColor="rgba(6,182,212,0.4)"
            borderRadius={10}
            disabled={busy || loading}
            onPress={onConfirm}
          >
            <Text color={ACCENT} fontSize={14} fontWeight="700">
              {busy ? t("profile.plan.applying") : t("profile.plan.confirm")}
            </Text>
          </Button>
        </XStack>
      )}
    </YStack>
  )
}

// ── Payment method (card on file + change) ───────────────────────────────────────

function PaymentMethodCard({
  card,
  editing,
  onEdit,
  onSuccess,
  onCancel,
}: {
  card: PaymentMethodView | null
  editing: boolean
  onEdit: () => void
  onSuccess: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  if (editing) {
    return (
      <YStack
        backgroundColor={c.bgInner}
        borderWidth={1}
        borderColor={c.border}
        borderRadius={16}
        padding={18}
      >
        <PaymentMethodSetup onSuccess={onSuccess} onCancel={onCancel} />
      </YStack>
    )
  }
  return (
    <XStack
      backgroundColor={c.bgInner}
      borderWidth={1}
      borderColor={c.border}
      borderRadius={16}
      padding={18}
      alignItems="center"
      gap={14}
    >
      <CreditCard size={22} color={card ? ACCENT : c.text2} />
      <YStack flex={1} gap={2}>
        {card ? (
          <>
            <Text testID="payment-card-display" fontSize={14} fontWeight="600" color={c.text}>
              {t("profile.plan.cardOnFile", {
                brand: card.brand.charAt(0).toUpperCase() + card.brand.slice(1),
                last4: card.last4,
              })}
            </Text>
            <Text fontSize={12} color={c.text2}>
              {t("profile.plan.cardExpires", {
                month: String(card.expMonth).padStart(2, "0"),
                year: card.expYear,
              })}
            </Text>
          </>
        ) : (
          <Text fontSize={14} color={c.text2}>
            {t("profile.plan.noCard")}
          </Text>
        )}
      </YStack>
      <Button
        testID="manage-payment"
        height={36}
        paddingHorizontal={14}
        backgroundColor={c.bgCardHover}
        borderWidth={1}
        borderColor={c.borderStrong}
        borderRadius={10}
        onPress={onEdit}
      >
        <Text fontSize={13} fontWeight="600" color={c.text}>
          {card ? t("profile.plan.changeCard") : t("profile.plan.addCard")}
        </Text>
      </Button>
    </XStack>
  )
}

// ── Invoice row (a11y: link targets ≥24px) ───────────────────────────────────────

function InvoiceLink({
  testID,
  icon,
  label,
  url,
}: {
  testID: string
  icon: React.ReactNode
  label: string
  url: string
}) {
  return (
    <XStack
      testID={testID}
      alignItems="center"
      gap={5}
      minHeight={24}
      paddingVertical={4}
      paddingRight={6}
      cursor="pointer"
      pressStyle={{ opacity: 0.6 }}
      onPress={() => Linking.openURL(url).catch(() => {})}
    >
      {icon}
      <Text fontSize={12} color={ACCENT}>
        {label}
      </Text>
    </XStack>
  )
}

function InvoiceRow({ invoice }: { invoice: InvoiceView }) {
  const { t } = useTranslation()
  const c = useColors()
  const label = invoice.invoiceNumber ?? formatDate(invoice.createdAt)
  return (
    <YStack
      testID={`invoice-${invoice.id}`}
      paddingVertical={12}
      borderBottomWidth={1}
      borderBottomColor={c.border}
      gap={6}
    >
      <XStack alignItems="center" gap={10}>
        <YStack flex={1} gap={2}>
          <Text fontSize={13} fontWeight="600" color={c.text}>
            {label}
          </Text>
          <Text fontSize={11} color={c.text2}>
            {formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}
          </Text>
        </YStack>
        <Text fontSize={13} fontWeight="600" color={c.text}>
          {formatMoney(invoice.amount, invoice.currency)}
        </Text>
        <Pill
          label={t(`profile.plan.invoiceStatus.${invoice.status}`)}
          tone={INVOICE_TONE[invoice.status]}
        />
      </XStack>
      {(invoice.hostedInvoiceUrl || invoice.invoicePdfUrl) && (
        <XStack gap={10}>
          {invoice.hostedInvoiceUrl && (
            <InvoiceLink
              testID={`invoice-view-${invoice.id}`}
              icon={<ExternalLink size={13} color={ACCENT} />}
              label={t("profile.plan.invoiceView")}
              url={invoice.hostedInvoiceUrl}
            />
          )}
          {invoice.invoicePdfUrl && (
            <InvoiceLink
              testID={`invoice-pdf-${invoice.id}`}
              icon={<FileText size={13} color={ACCENT} />}
              label={t("profile.plan.invoicePdf")}
              url={invoice.invoicePdfUrl}
            />
          )}
        </XStack>
      )}
    </YStack>
  )
}

// ── Main section ─────────────────────────────────────────────────────────────────

export function ProfilePlanSection({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const c = useColors()
  const toast = useToast()
  const client = getTerosClient()

  const [sub, setSub] = useState<SubscriptionView | null>(null)
  const [card, setCard] = useState<PaymentMethodView | null>(null)
  const [plans, setPlans] = useState<BillingPlanView[]>([])
  const [invoices, setInvoices] = useState<InvoiceView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [changing, setChanging] = useState(false)
  const [editingPayment, setEditingPayment] = useState(false)
  const [pending, setPending] = useState<BillingPlanView | null>(null)
  const [preview, setPreview] = useState<PlanChangePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // Tracks the latest preview request so a slower, out-of-order response for a
  // previously-selected plan can be discarded (review M1).
  const previewReqRef = useRef<string | null>(null)
  // Idempotency token for the in-flight paid-upgrade attempt (held stable across
  // retries of the same attempt so a re-confirm reuses the same Stripe invoice).
  const reqIdRef = useRef<string | null>(null)

  const waitForConnection = useCallback((): Promise<void> => {
    if (client.isConnected()) return Promise.resolve()
    return new Promise((resolve) => {
      const onConnected = () => {
        client.off("connected", onConnected)
        resolve()
      }
      client.on("connected", onConnected)
    })
  }, [client])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      await waitForConnection()
      const [{ subscription, paymentMethod }, { plans: list }] = await Promise.all([
        client.billing.getSubscription(),
        client.billing.listPlans(),
      ])
      setSub(subscription)
      setCard(paymentMethod)
      setPlans(list)
      // Invoices are best-effort: a failure there must not hide the plan.
      try {
        const { invoices: inv } = await client.billing.getInvoices()
        setInvoices(inv)
      } catch (err) {
        console.warn("[ProfilePlanSection] Failed to load invoices:", err)
        setInvoices([])
      }
    } catch (err) {
      console.error("[ProfilePlanSection] Failed to load billing:", err)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
    // client is a stable module singleton — intentionally not a dependency.
  }, [waitForConnection])

  useEffect(() => {
    load()
  }, [load])

  // Picking a plan card → fetch the real prorated quote, then show the confirm.
  const selectPlan = useCallback(
    async (plan: BillingPlanView) => {
      setPending(plan)
      setPreview(null)
      setPreviewLoading(true)
      previewReqRef.current = plan.planId
      reqIdRef.current = null // a newly selected plan is a fresh payment attempt
      try {
        const result = await client.billing.previewPlanChange(plan.planId)
        // Discard a stale response: if the user picked another plan while this
        // request was in flight, applying it would show the new plan with this
        // plan's prorated amount — a mismatch vs what gets charged (review M1).
        if (previewReqRef.current !== plan.planId) return
        setPreview(result)
      } catch (err: any) {
        if (previewReqRef.current !== plan.planId) return
        toast.error(t("profile.plan.toastChangeError"), err?.message)
        setPending(null)
      } finally {
        // Only the latest request clears the spinner; a superseded one leaves it
        // to the request that replaced it.
        if (previewReqRef.current === plan.planId) setPreviewLoading(false)
      }
    },
    [client, toast, t],
  )

  const confirmChange = useCallback(async () => {
    if (!pending || changing) return
    const plan = pending
    // A paid upgrade needs a card first; the confirm UI shows the card form
    // instead of a confirm button, so this only fires once a card is on file.
    // Defensive guard: never POST a paid upgrade we know the backend will refuse.
    const isPaidUpgrade = preview?.kind === "upgrade" && preview.prorationAmount > 0
    if (isPaidUpgrade && !card) return
    setChanging(true)
    try {
      // Idempotency token attached to EVERY change attempt — not only the ones the
      // frontend predicts will charge. The BACKEND is the authority on whether a
      // change is a paid upgrade (it recomputes the proration); the token is
      // harmless when it doesn't charge (downgrade / lateral / free → ignored).
      // Gating it on our own `isPaidUpgrade` prediction left a hole: a null/stale
      // preview at confirm time POSTed a paid upgrade with no token and the backend
      // refused it ("reqId is required for a paid upgrade" — TER-634). Held in
      // reqIdRef and reused across retries of THIS attempt so a re-confirm can't
      // double-charge.
      const reqId = reqIdRef.current ?? newReqId()
      reqIdRef.current = reqId // reused across retries of THIS attempt (no double-charge)
      const { kind, subscription } = await client.billing.changePlan(plan.planId, reqId)
      reqIdRef.current = null // this attempt completed; the next one is fresh
      if (subscription) setSub(subscription)
      if (kind === "downgrade_scheduled") {
        toast.success(
          t("profile.plan.toastDowngrade", { plan: plan.displayName }),
          subscription
            ? t("profile.plan.toastDowngradeDetail", {
                date: formatDate(subscription.currentPeriodEnd),
              })
            : undefined,
        )
      } else {
        toast.success(t("profile.plan.toastUpgraded", { plan: plan.displayName }))
      }
      setPending(null)
      setPreview(null)
      try {
        const { invoices: inv } = await client.billing.getInvoices()
        setInvoices(inv)
      } catch {
        /* best-effort refresh */
      }
    } catch (err: any) {
      // Decline → fresh token next time (maybe a new card); indeterminate error →
      // keep the token so a blind retry reuses the same invoice (no double-charge).
      if (isDeterministicPaymentFailure(err)) reqIdRef.current = null
      toast.error(t("profile.plan.toastChangeError"), err?.message)
    } finally {
      setChanging(false)
    }
  }, [pending, changing, client, toast, t, preview, card])

  // Card just vaulted from INSIDE the upgrade confirm: refresh it (without closing
  // the confirm) so the form is replaced by the confirm button and the user can
  // complete the upgrade in place.
  const handleCardAddedForUpgrade = useCallback(async () => {
    toast.success(t("profile.plan.toastPaymentSaved"))
    try {
      const { paymentMethod } = await client.billing.getSubscription()
      setCard(paymentMethod)
    } catch {
      /* best-effort: the confirm stays open; the user can retry */
    }
  }, [client, toast, t])

  const handlePaymentSuccess = useCallback(async () => {
    setEditingPayment(false)
    toast.success(t("profile.plan.toastPaymentSaved"))
    // Reflect the new card without a full reload.
    try {
      const { paymentMethod } = await client.billing.getSubscription()
      setCard(paymentMethod)
    } catch {
      /* best-effort */
    }
  }, [client, toast, t])

  const openSales = useCallback(() => {
    Linking.openURL(SALES_CONTACT_URL).catch(() => {})
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <XStack paddingHorizontal={24} paddingTop={20} paddingBottom={16} alignItems="center">
          <Button
            size="$3"
            circular
            backgroundColor={c.bgInner}
            borderWidth={0}
            onPress={onBack}
            pressStyle={{ backgroundColor: c.bgCardHover }}
          >
            <ArrowLeft size={20} color={c.text} />
          </Button>
          <Text flex={1} textAlign="center" fontSize={18} fontWeight="600" color={c.text}>
            {t("profile.plan.title")}
          </Text>
          <YStack width={40} />
        </XStack>

        {loading ? (
          <YStack paddingTop={60} alignItems="center">
            <AppSpinner size="lg" variant="brand" />
          </YStack>
        ) : loadError ? (
          <YStack paddingHorizontal={24} paddingTop={40} gap={16} alignItems="center">
            <Text testID="plan-load-error" fontSize={14} color={RED} textAlign="center">
              {t("profile.plan.loadError")}
            </Text>
            <Button
              testID="plan-retry"
              height={44}
              paddingHorizontal={20}
              backgroundColor="rgba(6,182,212,0.15)"
              borderWidth={1}
              borderColor="rgba(6,182,212,0.4)"
              borderRadius={10}
              onPress={load}
            >
              <Text color={ACCENT} fontSize={14} fontWeight="600">
                {t("profile.plan.retry")}
              </Text>
            </Button>
          </YStack>
        ) : (
          <YStack paddingHorizontal={24} paddingBottom={40} gap={28}>
            {sub ? (
              <UsageHero sub={sub} />
            ) : (
              <YStack
                testID="no-subscription"
                backgroundColor={c.bgInner}
                borderWidth={1}
                borderColor={c.border}
                borderRadius={16}
                padding={18}
              >
                <Text fontSize={14} color={c.text2} lineHeight={20}>
                  {t("profile.plan.noSubscription")}
                </Text>
              </YStack>
            )}

            {/* Compare & change plan */}
            {sub && plans.length > 0 && (
              <YStack>
                <SectionHeading
                  icon={<CreditCard size={14} color={c.text2} />}
                  label={t("profile.plan.changePlanHeading")}
                />
                <XStack flexWrap="wrap" gap={12}>
                  {plans.map((plan) => (
                    <PricingCard
                      key={plan.planId}
                      plan={plan}
                      sub={sub}
                      busy={changing}
                      onSelect={selectPlan}
                      onSales={openSales}
                    />
                  ))}
                </XStack>
                {pending && (
                  <ChangeConfirm
                    plan={pending}
                    preview={preview}
                    loading={previewLoading}
                    busy={changing}
                    card={card}
                    onConfirm={confirmChange}
                    onCancel={() => {
                      setPending(null)
                      setPreview(null)
                      reqIdRef.current = null
                    }}
                    onCardAdded={handleCardAddedForUpgrade}
                  />
                )}
              </YStack>
            )}

            {/* Payment method */}
            <YStack>
              <SectionHeading
                icon={<CreditCard size={14} color={c.text2} />}
                label={t("profile.plan.paymentHeading")}
              />
              <PaymentMethodCard
                card={card}
                editing={editingPayment}
                onEdit={() => setEditingPayment(true)}
                onSuccess={handlePaymentSuccess}
                onCancel={() => setEditingPayment(false)}
              />
            </YStack>

            {/* Invoices */}
            <YStack>
              <SectionHeading
                icon={<Receipt size={14} color={c.text2} />}
                label={t("profile.plan.invoicesHeading")}
              />
              {invoices.length === 0 ? (
                <XStack
                  testID="no-invoices"
                  backgroundColor={c.bgInner}
                  borderWidth={1}
                  borderColor={c.border}
                  borderRadius={16}
                  padding={18}
                  alignItems="center"
                  gap={8}
                >
                  <CheckCircle size={16} color={c.text2} />
                  <Text fontSize={13} color={c.text2}>
                    {t("profile.plan.noInvoices")}
                  </Text>
                </XStack>
              ) : (
                <YStack
                  backgroundColor={c.bgInner}
                  borderWidth={1}
                  borderColor={c.border}
                  borderRadius={16}
                  paddingHorizontal={18}
                  paddingVertical={6}
                >
                  {invoices.map((inv) => (
                    <InvoiceRow key={inv.id} invoice={inv} />
                  ))}
                </YStack>
              )}
            </YStack>
          </YStack>
        )}
      </ScrollView>
    </YStack>
  )
}
