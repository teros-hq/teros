/**
 * BillingSummary — the read view of a user's subscription for the admin detail
 * drill-in: plan / hours / effective price / status as `Stat` tiles, a usage
 * bar (base vs boost segments) and the read-only notes. Actions: "Editar"
 * (parent toggles the edit form), "Ver auditoría" (opens the scoped
 * billing-audit window) and "Exportar CSV".
 *
 * Presentational: ds `Stats` / `Card` / `Btn` / `Badge`; colours from
 * `useColors()`. The CSV escape hatch is confined to `exportCsv.ts`; audit
 * navigation goes through the tiling store exactly as the previous panel did.
 */

import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Badge, Btn, Card, Stat, Stats, T } from "../../../components/ui/ds"
import type { BillingInfo, UserSummary } from "../../../services/AdminApi"
import { useTilingStore } from "../../../store/tilingStore"
import { buildBillingCsv, downloadCsv } from "../exportCsv"
import { hoursTone, hoursUsage } from "../usersModel"
import { PeriodHoursCard } from "./PeriodHoursCard"

export interface BillingSummaryProps {
  user: UserSummary
  billing: BillingInfo
  onEdit: () => void
  /** Refetch the user detail after a period hour-boost grant/revoke changes the
   *  effective limit + usage. Threaded through to the PeriodHoursCard. */
  onChanged?: () => void
}

/** Bar fill tone: violet under 75%, amber to 90%, red above (visual bar). */
function barTone(pct: number): "i" | "a" | "r" {
  if (pct > 90) return "r"
  if (pct > 75) return "a"
  return "i"
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
    <View style={{ gap: 14 }} testID="billing-summary">
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Btn
          testID="billing-audit-btn"
          variant="sec"
          size="sm"
          icon="clock-counter-clockwise"
          onPress={() => openWindow("billing-audit", { userId: user.userId, userName })}
        >
          {t("windows.usersPanel.billing.viewAudit")}
        </Btn>
        <Btn
          testID="billing-export-btn"
          variant="sec"
          size="sm"
          icon="download-simple"
          onPress={onExport}
        >
          {t("windows.usersPanel.billing.exportCsv")}
        </Btn>
        <Btn
          testID="billing-edit-btn"
          variant="primary"
          size="sm"
          icon="pencil-simple"
          onPress={onEdit}
        >
          {t("windows.usersPanel.billing.edit")}
        </Btn>
      </View>

      <BillingKpis billing={billing} />
      <UsageBar billing={billing} />

      <PeriodHoursCard user={user} onChanged={onChanged} />

      <T step="12" tone="text3">
        {t("windows.usersPanel.billing.period")}:{" "}
        <T step="code" tone="text3">
          {billing.currentPeriodStart?.slice(0, 10) ?? "—"} →{" "}
          {billing.currentPeriodEnd?.slice(0, 10) ?? "—"}
        </T>
      </T>

      {billing.teamId ? (
        <Card nested pad>
          <T step="sm" tone="accent">
            {t("windows.usersPanel.billing.team")}: {billing.teamName ?? billing.teamId}
          </T>
          <T step="code" tone="text3" style={{ marginTop: 4 }}>
            {billing.teamId}
          </T>
        </Card>
      ) : null}

      {billing.billingNotes ? (
        <Card nested pad>
          <T step="xs" tone="text2" style={{ marginBottom: 6 }}>
            {t("windows.usersPanel.billing.notes")}
          </T>
          <T step="sm" tone="text2">
            {billing.billingNotes}
          </T>
        </Card>
      ) : null}
    </View>
  )
}

function BillingKpis({ billing }: { billing: BillingInfo }) {
  const { t } = useTranslation()
  const usage = hoursUsage(billing)
  const price = billing.effectivePrice ?? 0
  const tone = hoursTone(usage.pct, usage.unmetered)
  return (
    <Stats cols={4}>
      <Stat label={t("windows.usersPanel.billing.plan")} v={billing.planName} />
      <Stat
        label={t("windows.usersPanel.billing.hoursUsed")}
        v={usage.label}
        sub={usage.pct != null ? `${Math.round(usage.pct * 100)} %` : undefined}
        accent={tone === "a" || tone === "r"}
      />
      <Stat
        label={t("windows.usersPanel.billing.price")}
        v={price > 0 ? `€${price}` : t("windows.usersPanel.billing.free")}
      />
      <Stat label={t("windows.usersPanel.billing.status")} v={billing.billingStatus ?? "—"} />
    </Stats>
  )
}

function UsageBar({ billing }: { billing: BillingInfo }) {
  const { t } = useTranslation()
  const c = useColors()
  const limit = billing.effectiveLimit ?? 0
  const used = billing.agentHoursUsed ?? 0
  const boost = billing.boostHours ?? 0
  const overage = billing.overageHours ?? 0

  if (billing.unmetered === true || limit <= 0) return null

  const usedPct = Math.min((used / limit) * 100, 100)
  const basePct = Math.min((Math.max(limit - boost, 0) / limit) * 100, 100)
  const atLimit = used >= limit
  const tone = barTone(usedPct)
  const fill = tone === "i" ? c.accent : c.tint[tone].tx

  return (
    <View style={{ gap: 6 }}>
      <View
        style={{
          position: "relative",
          height: 6,
          borderRadius: 3,
          overflow: "hidden",
          backgroundColor: c.wash2,
        }}
      >
        {boost > 0 ? (
          <View
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              flexDirection: "row",
            }}
          >
            <View style={{ width: `${basePct}%` }} />
            <View style={{ flex: 1, backgroundColor: c.tint.i.bg }} />
          </View>
        ) : null}
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: `${usedPct}%`,
            borderRadius: 3,
            backgroundColor: fill,
          }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <T step="12" tone="text3">
          {t("windows.usersPanel.billing.pctUsed", { pct: usedPct.toFixed(0) })}
          {overage > 0
            ? ` · ${t("windows.usersPanel.billing.overage", { hours: overage.toFixed(1) })}`
            : ""}
          {boost > 0 ? ` · ${t("windows.usersPanel.billing.boost", { hours: boost })}` : ""}
        </T>
        {atLimit ? (
          <View testID="billing-limit-badge">
            <Badge tone="r" cap dot>
              {t("windows.usersPanel.billing.limitReached")}
            </Badge>
          </View>
        ) : null}
      </View>
    </View>
  )
}
