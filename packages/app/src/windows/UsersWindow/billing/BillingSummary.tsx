/**
 * BillingSummary — the read view of a user's subscription for the admin detail
 * drill-in: plan / effective price / hours (coloured by threshold) / status /
 * period / team, plus a usage bar (base vs boost segments) and the read-only
 * notes. Actions: "Editar" (parent toggles the edit form), "Ver auditoría"
 * (opens the scoped billing-audit window) and "Exportar CSV".
 *
 * Presentational: it composes monitoring KPI primitives + tokens (no hardcoded
 * hex, no StyleSheet). The CSV escape hatch is confined to `exportCsv.ts`; audit
 * navigation goes through the tiling store exactly as the previous billing panel did.
 */

import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../../components/monitoring/colors"
import { KpiStrip, KpiTile } from "../../../components/monitoring/Kpi"
import type { BillingInfo, UserSummary } from "../../../services/AdminApi"
import { useTilingStore } from "../../../store/tilingStore"
import { buildBillingCsv, downloadCsv } from "../exportCsv"
import { hoursColor, hoursUsage, planBadge } from "../usersModel"
import { Button } from "./formPrimitives"
import { PeriodHoursCard } from "./PeriodHoursCard"

export interface BillingSummaryProps {
  user: UserSummary
  billing: BillingInfo
  onEdit: () => void
  /** Refetch the user detail after a period hour-boost grant/revoke changes the
   *  effective limit + usage. Threaded through to the PeriodHoursCard. */
  onChanged?: () => void
}

/** Bar fill colour: green under 75%, amber to 90%, red above (visual bar). */
function barColor(pct: number): string {
  if (pct > 90) return tokens.error
  if (pct > 75) return tokens.warning
  return tokens.success
}

/** Billing status → value colour (paid→green, pending/invoiced→amber, overdue→red). */
function statusColor(status?: string): string {
  if (status === "paid") return tokens.success
  if (status === "pending" || status === "invoiced") return tokens.warning
  if (status === "overdue") return tokens.error
  return tokens.textTertiary
}

export function BillingSummary({ user, billing, onEdit, onChanged }: BillingSummaryProps) {
  const { t } = useTranslation()
  const openWindow = useTilingStore((s) => s.openWindow)

  const userName = user.profile.displayName ?? user.profile.email ?? user.userId

  const onExport = () => {
    const csv = buildBillingCsv({
      userId: user.userId,
      email: user.profile.email ?? "",
      planName: billing.planName,
      effectivePrice: billing.effectivePrice ?? 0,
      periodStart: billing.currentPeriodStart ?? "",
      periodEnd: billing.currentPeriodEnd ?? "",
      billingStatus: billing.billingStatus ?? "",
      billingNotes: billing.billingNotes ?? "",
    })
    downloadCsv(`billing-${user.userId}.csv`, csv)
  }

  return (
    <YStack gap={14} paddingTop={4} testID="billing-summary">
      <XStack ai="center" jc="flex-end" gap={8} flexWrap="wrap">
        <Button
          testID="billing-audit-btn"
          label={t("windows.usersPanel.billing.viewAudit")}
          onPress={() => openWindow("billing-audit", { userId: user.userId, userName })}
        />
        <Button
          testID="billing-export-btn"
          label={t("windows.usersPanel.billing.exportCsv")}
          onPress={onExport}
        />
        <Button
          testID="billing-edit-btn"
          label={t("windows.usersPanel.billing.edit")}
          tone="primary"
          onPress={onEdit}
        />
      </XStack>

      <BillingKpis billing={billing} />
      <UsageBar billing={billing} />

      <PeriodHoursCard user={user} onChanged={onChanged} />

      <Text fontSize={11} color={tokens.textMuted}>
        {t("windows.usersPanel.billing.period")}: {billing.currentPeriodStart?.slice(0, 10) ?? "—"}{" "}
        → {billing.currentPeriodEnd?.slice(0, 10) ?? "—"}
      </Text>

      {billing.teamId ? (
        <YStack
          gap={4}
          padding={12}
          borderRadius={10}
          borderWidth={1}
          borderColor={`${tokens.accent}33`}
          backgroundColor={`${tokens.accent}0F`}
        >
          <Text fontSize={13} fontWeight="600" color={tokens.accent}>
            {t("windows.usersPanel.billing.team")}: {billing.teamName ?? billing.teamId}
          </Text>
          <Text fontFamily="$mono" fontSize={11} color={tokens.textMuted}>
            {billing.teamId}
          </Text>
        </YStack>
      ) : null}

      {billing.billingNotes ? (
        <YStack
          gap={4}
          padding={10}
          borderRadius={8}
          borderWidth={1}
          borderColor={tokens.border}
          backgroundColor={tokens.bgInner}
        >
          <Text
            fontSize={10}
            fontWeight="600"
            letterSpacing={0.6}
            textTransform="uppercase"
            color={tokens.textTertiary}
          >
            {t("windows.usersPanel.billing.notes")}
          </Text>
          <Text fontSize={12} color={tokens.textSecondary} lineHeight={18}>
            {billing.billingNotes}
          </Text>
        </YStack>
      ) : null}
    </YStack>
  )
}

function BillingKpis({ billing }: { billing: BillingInfo }) {
  const { t } = useTranslation()
  const usage = hoursUsage(billing)
  const price = billing.effectivePrice ?? 0
  return (
    <KpiStrip>
      <KpiTile
        label={t("windows.usersPanel.billing.plan")}
        value={billing.planName}
        valueColor={planBadge(billing.planId, billing.planName).color}
      />
      <KpiTile
        label={t("windows.usersPanel.billing.hoursUsed")}
        value={usage.label}
        valueColor={hoursColor(usage.pct, usage.unmetered)}
      />
      <KpiTile
        label={t("windows.usersPanel.billing.price")}
        value={price > 0 ? `€${price}` : t("windows.usersPanel.billing.free")}
      />
      <KpiTile
        label={t("windows.usersPanel.billing.status")}
        value={billing.billingStatus ?? "—"}
        valueColor={statusColor(billing.billingStatus)}
      />
    </KpiStrip>
  )
}

function UsageBar({ billing }: { billing: BillingInfo }) {
  const { t } = useTranslation()
  const limit = billing.effectiveLimit ?? 0
  const used = billing.agentHoursUsed ?? 0
  const boost = billing.boostHours ?? 0
  const overage = billing.overageHours ?? 0

  if (billing.unmetered === true || limit <= 0) return null

  const usedPct = Math.min((used / limit) * 100, 100)
  const basePct = Math.min((Math.max(limit - boost, 0) / limit) * 100, 100)
  const atLimit = used >= limit

  return (
    <YStack gap={4}>
      <YStack
        position="relative"
        height={8}
        borderRadius={4}
        overflow="hidden"
        backgroundColor={tokens.bgInner}
      >
        {boost > 0 ? (
          <XStack position="absolute" top={0} left={0} right={0} bottom={0}>
            <YStack width={`${basePct}%`} backgroundColor={`${tokens.textMuted}33`} />
            <YStack flex={1} backgroundColor={`${tokens.accent}33`} />
          </XStack>
        ) : null}
        <YStack
          position="absolute"
          top={0}
          left={0}
          bottom={0}
          width={`${usedPct}%`}
          backgroundColor={barColor(usedPct)}
        />
      </YStack>
      <XStack ai="center" gap={8} flexWrap="wrap">
        <Text fontSize={11} color={tokens.textMuted}>
          {t("windows.usersPanel.billing.pctUsed", { pct: usedPct.toFixed(0) })}
          {overage > 0
            ? ` · ${t("windows.usersPanel.billing.overage", { hours: overage.toFixed(1) })}`
            : ""}
          {boost > 0 ? ` · ${t("windows.usersPanel.billing.boost", { hours: boost })}` : ""}
        </Text>
        {atLimit ? (
          <XStack
            testID="billing-limit-badge"
            ai="center"
            paddingVertical={2}
            paddingHorizontal={7}
            borderRadius={5}
            borderWidth={1}
            borderColor={`${tokens.error}55`}
            backgroundColor={`${tokens.error}1A`}
          >
            <Text
              fontSize={10}
              fontWeight="700"
              letterSpacing={0.4}
              textTransform="uppercase"
              color={tokens.error}
            >
              {t("windows.usersPanel.billing.limitReached")}
            </Text>
          </XStack>
        ) : null}
      </XStack>
    </YStack>
  )
}
