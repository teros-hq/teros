/**
 * Quota panel — agent-hours burn for the current calendar month, per user,
 * projected to end-of-month at the current daily rate. Agent-hours are ALWAYS
 * measured (activeMs), so this panel does not depend on the pricing gap.
 */

import { type Column, DataTable, SectionCard } from "../../../components/monitoring"
import { colors as semantic } from "../../../components/mca/primitives/colors"
import { useColors } from "../../../components/mca/primitives/useColors"
import type { QuotaSnapshot, UserQuotaSnapshot } from "../quota"
import { HBar, PanelNote, Stat, StatRow } from "./panelBits"

const fmtHrs = (h: number) => (h >= 10 ? h.toFixed(0) : h.toFixed(1))

export function QuotaPanel({
  quota,
  showInternalIds,
}: {
  quota: QuotaSnapshot
  showInternalIds: boolean
}) {
  const c = useColors()
  if (quota.totalConsumed <= 0) {
    return <PanelNote>No agent-hours consumed in the current month yet.</PanelNote>
  }

  const columns: Column<UserQuotaSnapshot>[] = [
    {
      key: "user",
      header: "User",
      width: 180,
      align: "left",
      mono: false,
      color: () => c.text,
      render: (u) => (showInternalIds ? u.userId : u.userName),
    },
    {
      key: "consumed",
      header: "Used (h)",
      width: 90,
      align: "right",
      mono: true,
      render: (u) => fmtHrs(u.consumedHours),
    },
    {
      key: "quota",
      header: "Quota (h)",
      width: 90,
      align: "right",
      mono: true,
      color: () => c.text3,
      render: (u) => fmtHrs(u.quotaHours),
    },
    {
      key: "pct",
      header: "Consumed",
      width: 160,
      flex: 1,
      align: "left",
      render: (u) => (
        <HBar
          value={u.pctConsumed / 100}
          // Over quota → red, nearing it → amber, otherwise the accent.
          color={
            u.pctConsumed >= 100 ? semantic.red : u.pctConsumed >= 80 ? semantic.amber : c.accent
          }
        />
      ),
    },
    {
      key: "pctn",
      header: "%",
      width: 56,
      align: "right",
      mono: true,
      render: (u) => `${u.pctConsumed.toFixed(0)}%`,
    },
    {
      key: "proj",
      header: "Projected",
      width: 96,
      align: "right",
      mono: true,
      color: (u) => (u.projectedHours > u.quotaHours ? c.tint.a.tx : c.text2),
      render: (u) => fmtHrs(u.projectedHours),
    },
  ]

  return (
    <>
      <SectionCard title="This month">
        <StatRow>
          <Stat
            label="Consumed"
            value={`${fmtHrs(quota.totalConsumed)} h`}
            sub={`of ${fmtHrs(quota.totalQuota)} h quota`}
          />
          <Stat
            label="Projected"
            value={`${fmtHrs(quota.totalProjected)} h`}
            sub={`at current rate · ${quota.daysLeft}d left`}
            color={quota.totalProjected > quota.totalQuota ? c.tint.a.tx : c.text}
          />
          <Stat
            label="Elapsed"
            value={`${quota.daysIntoPeriod}/${quota.daysInPeriod}`}
            sub="days into month"
          />
        </StatRow>
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
