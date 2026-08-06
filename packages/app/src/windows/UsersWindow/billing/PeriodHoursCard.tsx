/**
 * PeriodHoursCard — the TEMPORARY, period-scoped hour-boost control for the admin
 * per-user billing view (TER-687 · PR6).
 *
 * An admin grants a user extra agent-hours for the CURRENT period only: they add
 * to the period's effective limit, expire at renewal, and NEVER change the
 * permanent `customAgentHoursLimit` (that lives in BillingEditForm — kept visually
 * and textually distinct here). The card shows base + active boosts = effective,
 * the usage against it, the list of active boosts (from admin.get-billing-audit)
 * with an origin badge and a Revoke action, and a Grant dialog with a live
 * preview. Money-adjacent: the grant idempotencyKey is generated ONCE per opened
 * dialog (a double-click / retry never double-grants), validation blocks invalid
 * hours BEFORE the call, and Confirm is disabled while in-flight. Colours are
 * monitoring tokens; primitives are the shared Badge/IconChip/Empty.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"
import { Badge, Empty, IconChip } from "../../../components/mca/primitives"
import { tokens } from "../../../components/monitoring/colors"
import type { BillingAuditBoost, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { ConfirmDialog } from "../detail/ConfirmDialog"
import { formatDate, hoursUsage } from "../usersModel"
import { Button, FieldLabel, FormError, TextField } from "./formPrimitives"
import {
  boostOriginMeta,
  HOURS_MAX,
  HOURS_MIN,
  makeIdempotencyKey,
  newPeriodLimit,
  validateHours,
} from "./periodHours"

export interface PeriodHoursCardProps {
  user: UserSummary
  /** Called after a grant/revoke so the parent refetches getUserDetail (fresh
   *  effectiveLimit + usage bar). The card refetches its own boost list itself. */
  onChanged?: () => void
}

/** Integer stays integer, fractions show one decimal, non-finite → em dash. */
function fmtH(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function PeriodHoursCard({ user, onChanged }: PeriodHoursCardProps) {
  const { t } = useTranslation()
  const client = getTerosClient()

  const [boosts, setBoosts] = useState<BillingAuditBoost[]>([])
  const [grantOpen, setGrantOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<BillingAuditBoost | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const billing = user.billing
  const unmetered = billing?.unmetered === true
  const effective = billing?.effectiveLimit ?? 0
  const boostHours = billing?.boostHours ?? 0
  const base = Math.max(effective - boostHours, 0)
  const usage = hoursUsage(billing)

  const refetchBoosts = useCallback(() => {
    client.admin
      .getBillingAudit({ userId: user.userId })
      .then((audit) => setBoosts(audit.activeBoosts))
      .catch(() => setBoosts([]))
  }, [client, user.userId])

  useEffect(() => {
    refetchBoosts()
  }, [refetchBoosts])

  const afterChange = () => {
    onChanged?.()
    refetchBoosts()
  }

  const confirmRevoke = async () => {
    if (revokeTarget == null) return
    setRevoking(true)
    setRevokeError(null)
    try {
      await client.admin.revokeHourBoost({ targetUserId: user.userId, boostId: revokeTarget._id })
      setRevokeTarget(null)
      afterChange()
    } catch (e) {
      setRevokeError(
        (e as { message?: string })?.message ??
          t("windows.usersPanel.billing.periodHours.revokeFailed"),
      )
    } finally {
      setRevoking(false)
    }
  }

  return (
    <YStack
      testID="period-hours-card"
      gap={12}
      padding={14}
      borderRadius={12}
      borderWidth={1}
      borderColor={`${tokens.accent}33`}
      backgroundColor={`${tokens.accent}0D`}
    >
      <XStack ai="center" jc="space-between" gap={8} flexWrap="wrap">
        <XStack ai="center" gap={8}>
          <Text fontSize={14} fontWeight="650" color={tokens.text}>
            {t("windows.usersPanel.billing.periodHours.title")}
          </Text>
          <IconChip
            text={t("windows.usersPanel.billing.periodHours.temporaryTag")}
            accent={tokens.accent}
          />
        </XStack>
        {unmetered ? null : (
          <Button
            testID="period-grant-cta"
            label={t("windows.usersPanel.billing.periodHours.grantCta")}
            tone="primary"
            onPress={() => setGrantOpen(true)}
          />
        )}
      </XStack>

      {unmetered ? (
        <Text fontSize={12} color={tokens.textTertiary}>
          {t("windows.usersPanel.billing.periodHours.unmetered")}
        </Text>
      ) : (
        <>
          <Breakdown
            base={base}
            boost={boostHours}
            effective={effective}
            usageLabel={usage.label}
          />
          <Text fontSize={11} color={tokens.textMuted} lineHeight={16}>
            {t("windows.usersPanel.billing.periodHours.disclaimer", {
              date: formatDate(billing?.currentPeriodEnd),
            })}
          </Text>
          <BoostList boosts={boosts} onRevoke={setRevokeTarget} />
        </>
      )}

      {grantOpen ? (
        <GrantBoostDialog
          targetUserId={user.userId}
          currentEffective={effective}
          onClose={() => setGrantOpen(false)}
          onGranted={() => {
            setGrantOpen(false)
            afterChange()
          }}
        />
      ) : null}

      <ConfirmDialog
        open={revokeTarget != null}
        title={t("windows.usersPanel.billing.periodHours.revokeTitle")}
        body={
          <YStack gap={10}>
            <Text fontSize={13} lineHeight={20} color={tokens.textTertiary}>
              {t("windows.usersPanel.billing.periodHours.revokeConsequence", {
                from: fmtH(effective),
                to: fmtH(newPeriodLimit(effective, -(revokeTarget?.hours ?? 0))),
              })}
            </Text>
            {revokeError ? <FormError message={revokeError} testID="period-revoke-error" /> : null}
          </YStack>
        }
        confirmLabel={t("windows.usersPanel.billing.periodHours.revokeConfirm")}
        cancelLabel={t("windows.usersPanel.billing.cancel")}
        tone="danger"
        busy={revoking}
        onConfirm={confirmRevoke}
        onCancel={() => {
          setRevokeTarget(null)
          setRevokeError(null)
        }}
      />
    </YStack>
  )
}

function Breakdown({
  base,
  boost,
  effective,
  usageLabel,
}: {
  base: number
  boost: number
  effective: number
  usageLabel: string
}) {
  const { t } = useTranslation()
  const boostColor = boost > 0 ? tokens.accent : tokens.textMuted
  return (
    <YStack gap={5}>
      <Row
        label={t("windows.usersPanel.billing.periodHours.baseLimit")}
        value={`${fmtH(base)} h`}
      />
      <Row
        label={t("windows.usersPanel.billing.periodHours.activeExtra")}
        value={`+ ${fmtH(boost)} h`}
        valueColor={boostColor}
      />
      <Row
        label={t("windows.usersPanel.billing.periodHours.effectiveLimit")}
        value={`= ${fmtH(effective)} h`}
        valueColor={tokens.text}
        bold
      />
      <Row
        label={t("windows.usersPanel.billing.periodHours.usage")}
        value={usageLabel}
        valueColor={tokens.textSecondary}
      />
    </YStack>
  )
}

function Row({
  label,
  value,
  valueColor,
  bold,
}: {
  label: string
  value: string
  valueColor?: string
  bold?: boolean
}) {
  return (
    <XStack ai="center" jc="space-between" gap={10}>
      <Text fontSize={12} color={tokens.textTertiary}>
        {label}
      </Text>
      <Text
        fontFamily="$mono"
        fontSize={13}
        fontWeight={bold ? "700" : "500"}
        color={valueColor ?? tokens.textSecondary}
      >
        {value}
      </Text>
    </XStack>
  )
}

function BoostList({
  boosts,
  onRevoke,
}: {
  boosts: BillingAuditBoost[]
  onRevoke: (b: BillingAuditBoost) => void
}) {
  const { t } = useTranslation()
  if (boosts.length === 0) {
    return <Empty message={t("windows.usersPanel.billing.periodHours.noBoosts")} />
  }
  return (
    <YStack gap={8} testID="period-boost-list">
      {boosts.map((b) => (
        <BoostRow key={b._id} boost={b} onRevoke={onRevoke} />
      ))}
    </YStack>
  )
}

function BoostRow({
  boost,
  onRevoke,
}: {
  boost: BillingAuditBoost
  onRevoke: (b: BillingAuditBoost) => void
}) {
  const { t } = useTranslation()
  const origin = boostOriginMeta(boost.source)
  return (
    <XStack
      ai="center"
      jc="space-between"
      gap={10}
      padding={10}
      borderRadius={8}
      borderWidth={1}
      borderColor={tokens.border}
      backgroundColor={tokens.bgInner}
      flexWrap="wrap"
    >
      <YStack gap={4} minWidth={0} flex={1}>
        <XStack ai="center" gap={8} flexWrap="wrap">
          <Text fontFamily="$mono" fontSize={14} fontWeight="700" color={tokens.text}>
            +{fmtH(boost.hours)} h
          </Text>
          <Badge text={t(origin.labelKey)} variant={origin.variant} />
        </XStack>
        <Text fontSize={11} color={tokens.textMuted} numberOfLines={1}>
          {t("windows.usersPanel.billing.periodHours.grantedBy", {
            who: boost.grantedBy,
            date: formatDate(boost.createdAt),
          })}
        </Text>
        {boost.note ? (
          <Text fontSize={11} color={tokens.textTertiary} numberOfLines={2}>
            {boost.note}
          </Text>
        ) : null}
      </YStack>
      <Button
        testID={`period-revoke-${boost._id}`}
        label={t("windows.usersPanel.billing.periodHours.revoke")}
        tone="danger"
        onPress={() => onRevoke(boost)}
      />
    </XStack>
  )
}

function GrantBoostDialog({
  targetUserId,
  currentEffective,
  onClose,
  onGranted,
}: {
  targetUserId: string
  currentEffective: number
  onClose: () => void
  onGranted: () => void
}) {
  const { t } = useTranslation()
  const client = getTerosClient()

  // Generated ONCE per opened dialog: a double-click / retry reuses the SAME key
  // so the backend never double-grants. Regenerated only on the next open (remount).
  const [idempotencyKey] = useState(() => makeIdempotencyKey())
  const [hoursText, setHoursText] = useState("")
  const [note, setNote] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const check = validateHours(hoursText)
  const valid = check.ok
  const previewTo = valid ? newPeriodLimit(currentEffective, check.hours) : currentEffective

  const confirm = async () => {
    if (!valid || inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    try {
      await client.admin.grantHourBoost({
        targetUserId,
        hours: check.hours,
        note: note.trim() || undefined,
        idempotencyKey,
      })
      onGranted()
    } catch (e) {
      setError(
        (e as { message?: string })?.message ??
          t("windows.usersPanel.billing.periodHours.grantFailed"),
      )
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open
      title={t("windows.usersPanel.billing.periodHours.grantTitle")}
      body={
        <YStack gap={12}>
          <YStack>
            <FieldLabel>
              {t("windows.usersPanel.billing.periodHours.grantHoursLabel", {
                min: HOURS_MIN,
                max: HOURS_MAX,
              })}
            </FieldLabel>
            <TextField
              testID="period-grant-hours"
              value={hoursText}
              onChangeText={setHoursText}
              placeholder={t("windows.usersPanel.billing.periodHours.grantHoursPlaceholder")}
              numeric
            />
          </YStack>
          <YStack>
            <FieldLabel>{t("windows.usersPanel.billing.periodHours.grantNoteLabel")}</FieldLabel>
            <TextField
              testID="period-grant-note"
              value={note}
              onChangeText={setNote}
              placeholder={t("windows.usersPanel.billing.periodHours.grantNotePlaceholder")}
            />
          </YStack>
          <Text testID="period-grant-preview" fontSize={13} color={tokens.accent} fontWeight="600">
            {t("windows.usersPanel.billing.periodHours.grantPreview", {
              from: fmtH(currentEffective),
              to: fmtH(previewTo),
            })}
          </Text>
          {error ? <FormError message={error} testID="period-grant-error" /> : null}
        </YStack>
      }
      confirmLabel={t("windows.usersPanel.billing.periodHours.grantConfirm")}
      cancelLabel={t("windows.usersPanel.billing.cancel")}
      busy={submitting || !valid}
      onConfirm={confirm}
      onCancel={onClose}
    />
  )
}
