/**
 * Quota panel — agent-hours burn for the current calendar month, per user,
 * projected to end-of-month at the current daily rate. Agent-hours are ALWAYS
 * measured (activeMs), so this panel does not depend on the pricing gap.
 */

import { XStack } from "tamagui"
import { type Column, DataTable, SectionCard, tokens } from "../../../components/monitoring"
import { colors as semanticColors } from "../../../components/mca/primitives/colors"
import type { QuotaSnapshot, UserQuotaSnapshot } from "../quota"
import { HBar, PanelNote, Stat } from "./panelBits"

const fmtHrs = (h: number) => (h >= 10 ? h.toFixed(0) : h.toFixed(1))

export function QuotaPanel({ quota, showInternalIds }: { quota: QuotaSnapshot; showInternalIds: boolean }) {
  if (quota.totalConsumed <= 0) {
    return <PanelNote>No agent-hours consumed in the current month yet.</PanelNote>
  }

  const columns: Column<UserQuotaSnapshot>[] = [
    {
      key: "user",
      header: "User",
      width: 180,
      align: "left",
      render: (u) => (showInternalIds ? u.userId : u.userName),
    },
    { key: "consumed", header: "Used (h)", width: 90, align: "right", mono: true, render: (u) => fmtHrs(u.consumedHours) },
    { key: "quota", header: "Quota (h)", width: 90, align: "right", mono: true, color: () => tokens.textTertiary, render: (u) => fmtHrs(u.quotaHours) },
    {
      key: "pct",
      header: "Consumed",
      width: 160,
      flex: 1,
      align: "left",
      render: (u) => (
        <HBar
          value={u.pctConsumed / 100}
          color={u.pctConsumed >= 100 ? tokens.warning : u.pctConsumed >= 80 ? semanticColors.amber : tokens.success}
        />
      ),
    },
    { key: "pctn", header: "%", width: 56, align: "right", mono: true, render: (u) => `${u.pctConsumed.toFixed(0)}%` },
    {
      key: "proj",
      header: "Projected",
      width: 96,
      align: "right",
      mono: true,
      color: (u) => (u.projectedHours > u.quotaHours ? tokens.warning : tokens.textSecondary),
      render: (u) => fmtHrs(u.projectedHours),
    },
  ]

  return (
    <>
      <SectionCard title="This month">
        <XStack gap={36} flexWrap="wrap">
          <Stat label="Consumed" value={`${fmtHrs(quota.totalConsumed)} h`} sub={`of ${fmtHrs(quota.totalQuota)} h quota`} />
          <Stat
            label="Projected"
            value={`${fmtHrs(quota.totalProjected)} h`}
            sub={`at current rate · ${quota.daysLeft}d left`}
            color={quota.totalProjected > quota.totalQuota ? tokens.warning : tokens.text}
          />
          <Stat label="Elapsed" value={`${quota.daysIntoPeriod}/${quota.daysInPeriod}`} sub="days into month" />
        </XStack>
      </SectionCard>

      <SectionCard title="By user">
        {quota.userSnapshots.length > 0 ? (
          <DataTable columns={columns} rows={quota.userSnapshots} rowKey={(u) => u.userId} />
        ) : (
          <PanelNote>No per-user activity this month.</PanelNote>
        )}
      </SectionCard>
    </>
  )
}
