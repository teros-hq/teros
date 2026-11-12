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
 * hours BEFORE the call, and Confirm is disabled while in-flight. Presentation:
 * a nested ds `Card` with a violet-tinted border, `Badge` / `Btn` / `Field`.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Badge, Btn, Card, EmptyHint, T } from "../../../components/ui/ds"
import type { BillingAuditBoost, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { ConfirmDialog } from "../detail/ConfirmDialog"
import { formatDate, hoursUsage, variantTone } from "../usersModel"
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
  const c = useColors()

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
    <Card nested pad testID="period-hours-card" style={{ borderColor: c.tint.i.bd, gap: 12 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <T step="base">{t("windows.usersPanel.billing.periodHours.title")}</T>
          <Badge tone="i" pill cap>
            {t("windows.usersPanel.billing.periodHours.temporaryTag")}
          </Badge>
        </View>
        {unmetered ? null : (
          <Btn
            testID="period-grant-cta"
            variant="primary"
            size="sm"
            icon="plus"
            onPress={() => setGrantOpen(true)}
          >
            {t("windows.usersPanel.billing.periodHours.grantCta")}
          </Btn>
        )}
      </View>

      {unmetered ? (
        <T step="sm" tone="text3">
          {t("windows.usersPanel.billing.periodHours.unmetered")}
        </T>
      ) : (
        <>
          <Breakdown
            base={base}
            boost={boostHours}
            effective={effective}
            usageLabel={usage.label}
          />
          <T step="12" tone="text3">
            {t("windows.usersPanel.billing.periodHours.disclaimer", {
              date: formatDate(billing?.currentPeriodEnd),
            })}
          </T>
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
          <View style={{ gap: 10 }}>
            <T step="sm" tone="text2">
              {t("windows.usersPanel.billing.periodHours.revokeConsequence", {
                from: fmtH(effective),
                to: fmtH(newPeriodLimit(effective, -(revokeTarget?.hours ?? 0))),
              })}
            </T>
            {revokeError ? <FormError message={revokeError} testID="period-revoke-error" /> : null}
          </View>
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
    </Card>
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
  const c = useColors()
  return (
    <View style={{ gap: 6 }}>
      <Row
        label={t("windows.usersPanel.billing.periodHours.baseLimit")}
        value={`${fmtH(base)} h`}
      />
      <Row
        label={t("windows.usersPanel.billing.periodHours.activeExtra")}
        value={`+ ${fmtH(boost)} h`}
        valueColor={boost > 0 ? c.accent : c.text3}
      />
      <Row
        label={t("windows.usersPanel.billing.periodHours.effectiveLimit")}
        value={`= ${fmtH(effective)} h`}
        valueColor={c.text}
        big
      />
      <Row label={t("windows.usersPanel.billing.periodHours.usage")} value={usageLabel} />
    </View>
  )
}

function Row({
  label,
  value,
  valueColor,
  big,
}: {
  label: string
  value: string
  valueColor?: string
  big?: boolean
}) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <T step="12" tone="text3">
        {label}
      </T>
      <T step={big ? "code13" : "code"} color={valueColor ?? c.text2}>
        {value}
      </T>
    </View>
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
  const c = useColors()
  if (boosts.length === 0) {
    return (
      <EmptyHint style={{ paddingHorizontal: 0 }}>
        {t("windows.usersPanel.billing.periodHours.noBoosts")}
      </EmptyHint>
    )
  }
  return (
    <View testID="period-boost-list" style={{ borderTopWidth: 1, borderTopColor: c.border }}>
      {boosts.map((b) => (
        <BoostRow key={b._id} boost={b} onRevoke={onRevoke} />
      ))}
    </View>
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
  const c = useColors()
  const origin = boostOriginMeta(boost.source)
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        flexWrap: "wrap",
      }}
    >
      <View style={{ gap: 3, minWidth: 0, flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <T step="code13">{`+${fmtH(boost.hours)} h`}</T>
          <Badge tone={variantTone(origin.variant)} sm>
            {t(origin.labelKey)}
          </Badge>
        </View>
        <T step="12" tone="text3" numberOfLines={1}>
          {t("windows.usersPanel.billing.periodHours.grantedBy", {
            who: boost.grantedBy,
            date: formatDate(boost.createdAt),
          })}
        </T>
        {boost.note ? (
          <T step="12" tone="text2" numberOfLines={2}>
            {boost.note}
          </T>
        ) : null}
      </View>
      <Button
        testID={`period-revoke-${boost._id}`}
        label={t("windows.usersPanel.billing.periodHours.revoke")}
        tone="danger"
        onPress={() => onRevoke(boost)}
      />
    </View>
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
        <View style={{ gap: 14 }}>
          <View>
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
          </View>
          <View>
            <FieldLabel>{t("windows.usersPanel.billing.periodHours.grantNoteLabel")}</FieldLabel>
            <TextField
              testID="period-grant-note"
              value={note}
              onChangeText={setNote}
              placeholder={t("windows.usersPanel.billing.periodHours.grantNotePlaceholder")}
            />
          </View>
          <T testID="period-grant-preview" step="sm" tone="accent">
            {t("windows.usersPanel.billing.periodHours.grantPreview", {
              from: fmtH(currentEffective),
              to: fmtH(previewTo),
            })}
          </T>
          {error ? <FormError message={error} testID="period-grant-error" /> : null}
        </View>
      }
      confirmLabel={t("windows.usersPanel.billing.periodHours.grantConfirm")}
      cancelLabel={t("windows.usersPanel.billing.cancel")}
      busy={submitting || !valid}
      onConfirm={confirm}
      onCancel={onClose}
    />
  )
}
