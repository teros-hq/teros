/**
 * BoostModal — reusable modal to get extra agent-hours for the current period
 * (TER-596 I4). Opened from the 80% banner and the hard-block widget; replaces
 * the old inline BoostRequestForm.
 *
 * Two modes, decided by the caller's subscription (billing.get-subscription):
 *   - INDIVIDUAL (no teamId)  → BUY the hours: charges the vaulted card via
 *     billing.purchase-boost. Shows the cost up-front (boostPricing). If no card
 *     is on file the backend answers NO_PAYMENT_METHOD and we surface the
 *     reusable PaymentMethodSetup, then retry the SAME purchase (idempotent
 *     reqId → no double-charge). When boostPricing is null (Stripe off / price
 *     unset) the buy form is replaced by an "unavailable" notice.
 *   - TEAM (teamId set)       → REQUEST the hours from the company admin via
 *     billing.request-access (decision #10). No charge.
 *
 * The Dialog chrome (portal/overlay) is split from <BoostPanel>, which is the
 * loader/router, and the two forms (<BuyForm>/<TeamRequestForm>) hold their own
 * state. All three are render-tested directly (the portal is exercised only by
 * the live smoke).
 */

import { Minus, Plus, X } from "@tamagui/lucide-icons"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button, Dialog, Input, Text, TextArea, XStack, YStack } from "tamagui"
import i18n from "../../i18n"
import type { BoostPricingView, SubscriptionView } from "../../services/BillingApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"
import { useToast } from "../Toast"
import { PaymentMethodSetup } from "./PaymentMethodSetup"

const MIN_HOURS = 1
const MAX_HOURS = 10000
const DEFAULT_HOURS = 10
const STEP = 5
const ACCENT = "#06B6D4"

function clampHours(n: number): number {
  if (!Number.isFinite(n)) return MIN_HOURS
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.floor(n)))
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(i18n.language, { style: "currency", currency }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

// ── Shared presentational bits ─────────────────────────────────────────────────

function HoursStepper({
  hours,
  onChange,
  disabled,
}: {
  hours: number
  onChange: (h: number) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <XStack alignItems="center" justifyContent="space-between" gap={12}>
      <Text fontSize={13} color={c.text2}>
        {t("billing.boost.hoursLabel")}
      </Text>
      <XStack alignItems="center" gap={10}>
        <Button
          testID="boost-hours-dec"
          size="$2"
          circular
          icon={Minus}
          disabled={disabled || hours <= MIN_HOURS}
          backgroundColor={c.bgCardHover}
          onPress={() => onChange(clampHours(hours - STEP))}
        />
        <Input
          testID="boost-hours-value"
          width={68}
          textAlign="center"
          keyboardType="number-pad"
          editable={!disabled}
          value={String(hours)}
          onChangeText={(v) => onChange(clampHours(Number(v.replace(/[^0-9]/g, "")) || MIN_HOURS))}
          backgroundColor={c.bgInner}
          borderColor={c.border}
          color={c.text}
          fontSize={15}
        />
        <Button
          testID="boost-hours-inc"
          size="$2"
          circular
          icon={Plus}
          disabled={disabled || hours >= MAX_HOURS}
          backgroundColor={c.bgCardHover}
          onPress={() => onChange(clampHours(hours + STEP))}
        />
      </XStack>
    </XStack>
  )
}

function PrimaryButton({
  testID,
  label,
  busy,
  onPress,
}: {
  testID: string
  label: string
  busy: boolean
  onPress: () => void
}) {
  return (
    <Button
      testID={testID}
      height={44}
      borderRadius={10}
      backgroundColor="rgba(6,182,212,0.15)"
      borderWidth={1}
      borderColor="rgba(6,182,212,0.4)"
      disabled={busy}
      opacity={busy ? 0.6 : 1}
      pressStyle={{ backgroundColor: "rgba(6,182,212,0.25)" }}
      onPress={onPress}
    >
      <Text color={ACCENT} fontSize={14} fontWeight="700">
        {label}
      </Text>
    </Button>
  )
}

function DoneBlock({ message, onClose }: { message: string; onClose: () => void }) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <YStack gap={12}>
      <Text testID="boost-done" fontSize={14} color={c.text} lineHeight={20}>
        {message}
      </Text>
      <PrimaryButton
        testID="boost-done-close"
        label={t("billing.boost.close")}
        busy={false}
        onPress={onClose}
      />
    </YStack>
  )
}

function ErrorLine({ message }: { message: string }) {
  return (
    <Text testID="boost-error" fontSize={12} color={semanticColors.red} lineHeight={17}>
      {message}
    </Text>
  )
}

// ── Individual: buy hours (charges the vaulted card) ───────────────────────────

function BuyForm({ pricing, onClose }: { pricing: BoostPricingView; onClose: () => void }) {
  const { t } = useTranslation()
  const c = useColors()
  const toast = useToast()
  const client = getTerosClient()
  const [hours, setHours] = useState(DEFAULT_HOURS)
  const [status, setStatus] = useState<"idle" | "submitting" | "need_card" | "done" | "error">(
    "idle",
  )
  const [doneMsg, setDoneMsg] = useState("")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Idempotency token: one per payment ATTEMPT. Reused across a NO_PAYMENT_METHOD
  // retry (no charge happened); a fresh one only after a decline.
  const reqIdRef = useRef<string | null>(null)

  const runPurchase = useCallback(
    async (reqId: string) => {
      setStatus("submitting")
      setErrorMsg(null)
      try {
        const res = await client.billing.purchaseBoost(hours, reqId)
        reqIdRef.current = null
        const amount = formatMoney(res.amount, res.currency)
        setDoneMsg(t("billing.boost.boughtBody", { hours: res.hours, amount }))
        setStatus("done")
        toast.success(
          t("billing.toast.boughtTitle"),
          t("billing.boost.boughtBody", { hours: res.hours, amount }),
        )
      } catch (err) {
        const code = (err as { code?: string })?.code
        if (code === "NO_PAYMENT_METHOD") {
          setStatus("need_card") // keep the SAME reqId for the post-vault retry
        } else {
          // A CODED error means the backend reached a decision (decline, validation,
          // config) — no un-acknowledged charge — so a retry is a fresh attempt and
          // gets a new reqId. A transport error (timeout / WS close, NO code) is
          // INDETERMINATE: the charge may have succeeded but the response was lost, so
          // KEEP the reqId — the retry replays the same purchaseId and the server's
          // idempotency prevents a double charge (review C3).
          if (code) reqIdRef.current = null
          setErrorMsg((err as { message?: string })?.message || t("billing.boost.errorGeneric"))
          setStatus("error")
        }
      }
    },
    [client, hours, toast, t],
  )

  if (status === "done") return <DoneBlock message={doneMsg} onClose={onClose} />

  if (status === "need_card") {
    return (
      <YStack gap={10}>
        <Text fontSize={13} color={c.text2} lineHeight={19}>
          {t("billing.boost.needCardBody")}
        </Text>
        <PaymentMethodSetup
          onSuccess={() => runPurchase(reqIdRef.current ?? crypto.randomUUID())}
          onCancel={() => setStatus("idle")}
        />
      </YStack>
    )
  }

  const busy = status === "submitting"
  return (
    <YStack gap={14}>
      <HoursStepper hours={hours} onChange={setHours} disabled={busy} />
      <XStack alignItems="center" justifyContent="space-between">
        <Text fontSize={13} color={c.text2}>
          {t("billing.boost.total")}
        </Text>
        <Text testID="boost-total" fontSize={18} fontWeight="800" color={c.text}>
          {formatMoney(hours * pricing.hourPrice, pricing.currency)}
        </Text>
      </XStack>
      {status === "error" && errorMsg && <ErrorLine message={errorMsg} />}
      <PrimaryButton
        testID="boost-buy"
        label={busy ? t("billing.boost.buying") : t("billing.boost.buyCta", { hours })}
        busy={busy}
        onPress={() => {
          if (!reqIdRef.current) reqIdRef.current = crypto.randomUUID()
          runPurchase(reqIdRef.current)
        }}
      />
    </YStack>
  )
}

// ── Team: request hours from the admin ─────────────────────────────────────────

function TeamRequestForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const c = useColors()
  const toast = useToast()
  const client = getTerosClient()
  const [hours, setHours] = useState(DEFAULT_HOURS)
  const [reason, setReason] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle")
  const [doneMsg, setDoneMsg] = useState("")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const submit = useCallback(async () => {
    setStatus("submitting")
    setErrorMsg(null)
    try {
      await client.billing.requestAccess({
        requestedHours: hours,
        reason: reason.trim() || undefined,
      })
      setDoneMsg(t("billing.boost.requestedBody"))
      setStatus("done")
      toast.success(t("billing.toast.requestedTitle"))
    } catch (err) {
      if ((err as { code?: string })?.code === "REQUEST_PENDING") {
        setDoneMsg(t("billing.boost.pendingBody"))
        setStatus("done")
      } else {
        setErrorMsg(t("billing.boost.errorGeneric"))
        setStatus("error")
      }
    }
  }, [client, hours, reason, toast, t])

  if (status === "done") return <DoneBlock message={doneMsg} onClose={onClose} />

  const busy = status === "submitting"
  return (
    <YStack gap={14}>
      <HoursStepper hours={hours} onChange={setHours} disabled={busy} />
      <TextArea
        testID="boost-reason"
        value={reason}
        onChangeText={setReason}
        placeholder={t("billing.boost.reasonPlaceholder")}
        placeholderTextColor={c.text3}
        backgroundColor={c.bgInner}
        borderColor={c.border}
        color={c.text}
        fontSize={13}
        minHeight={56}
        maxLength={1000}
        editable={!busy}
      />
      {status === "error" && errorMsg && <ErrorLine message={errorMsg} />}
      <PrimaryButton
        testID="boost-request"
        label={busy ? t("billing.boost.requesting") : t("billing.boost.requestCta", { hours })}
        busy={busy}
        onPress={submit}
      />
    </YStack>
  )
}

function UnavailableNotice({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <YStack gap={10}>
      <Text testID="boost-unavailable" fontSize={13} color={c.text2} lineHeight={19}>
        {t("billing.boost.unavailableBody")}
      </Text>
      <PrimaryButton
        testID="boost-unavailable-close"
        label={t("billing.boost.close")}
        busy={false}
        onPress={onClose}
      />
    </YStack>
  )
}

// ── Panel (loader + router; render-tested directly, no portal) ─────────────────

export function BoostPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const [status, setStatus] = useState<"loading" | "load_error" | "ready">("loading")
  const [teamMode, setTeamMode] = useState(false)
  const [pricing, setPricing] = useState<BoostPricingView | null>(null)

  const load = useCallback(async () => {
    setStatus("loading")
    try {
      const { subscription, boostPricing } = await client.billing.getSubscription()
      setTeamMode(Boolean((subscription as SubscriptionView | null)?.teamId))
      setPricing(boostPricing)
      setStatus("ready")
    } catch {
      setStatus("load_error")
    }
    // client is a stable module singleton — intentionally not a dependency.
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const buyAvailable = !teamMode && pricing !== null
  const title = teamMode
    ? t("billing.boost.requestTitle")
    : buyAvailable
      ? t("billing.boost.buyTitle")
      : t("billing.boost.unavailableTitle")

  return (
    <YStack testID="boost-panel" padding={20} gap={16} backgroundColor={c.bgPage}>
      <XStack alignItems="center" gap={10}>
        <Text flex={1} fontSize={17} fontWeight="700" color={c.text}>
          {title}
        </Text>
        <Button
          testID="boost-close"
          size="$2"
          circular
          chromeless
          icon={<X size={18} color={c.text2} />}
          onPress={onClose}
        />
      </XStack>

      {status === "loading" && (
        <Text testID="boost-loading" fontSize={13} color={c.text2} paddingVertical={8}>
          {t("billing.boost.loading")}
        </Text>
      )}
      {status === "load_error" && (
        <Text testID="boost-load-error" fontSize={13} color={semanticColors.red} paddingVertical={8}>
          {t("billing.boost.loadError")}
        </Text>
      )}
      {status === "ready" &&
        (teamMode ? (
          <TeamRequestForm onClose={onClose} />
        ) : buyAvailable && pricing ? (
          <BuyForm pricing={pricing} onClose={onClose} />
        ) : (
          <UnavailableNotice onClose={onClose} />
        ))}
    </YStack>
  )
}

// ── Modal chrome (Dialog portal; covered by the live smoke) ────────────────────

export function BoostModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const c = useColors()
  return (
    <Dialog modal open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay
          key="overlay"
          animation="card"
          opacity={0.6}
          backgroundColor="rgba(0,0,0,0.6)"
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
          width={420}
          maxWidth="90vw"
          padding={0}
          backgroundColor={c.bgPage}
          borderColor={c.border}
        >
          {open && <BoostPanel onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
