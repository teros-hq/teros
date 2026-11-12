/**
 * Tokens panel — aggregate input-composition (SessionTokenBreakdown) across the
 * loaded sessions, as proportion bars. Honest degradation: sessions whose
 * provider/adapter never emitted a breakdown (e.g. kimi) are counted and
 * surfaced, not silently dropped.
 */

import { useMemo } from "react"
import { View } from "react-native"
import { fmtCount, SectionCard } from "../../../components/monitoring"
import { useColors } from "../../../components/mca/primitives/useColors"
import { T } from "../../../components/ui/ds/Text"
import type { AgentUsageSessionSummary, SessionTokenBreakdown } from "../../../services/AdminApi"
import { isUsageUnmeasured } from "../cache"
import { BarRow, HBar, PanelNote, Stat, StatRow } from "./panelBits"

const CATEGORIES: { key: keyof SessionTokenBreakdown; label: string }[] = [
  { key: "system", label: "System" },
  { key: "tools", label: "Tool schemas" },
  { key: "examples", label: "Examples" },
  { key: "memory", label: "Memory" },
  { key: "summary", label: "Summary" },
  { key: "conversation", label: "Conversation" },
  { key: "toolCalls", label: "Tool calls" },
  { key: "toolResults", label: "Tool results" },
  { key: "output", label: "Output" },
]

/**
 * Compact per-session breakdown (for the expanded row detail in the Sessions
 * table) — same categories as the aggregate panel, in miniature.
 */
export function BreakdownMini({ breakdown }: { breakdown: SessionTokenBreakdown }) {
  const rows = CATEGORIES.map((c) => ({ ...c, value: breakdown[c.key] || 0 })).filter(
    (r) => r.value > 0,
  )
  const total = rows.reduce((a, r) => a + r.value, 0)
  if (total === 0) return null
  return (
    <View style={{ gap: 5, maxWidth: 520 }}>
      {rows
        .sort((a, b) => b.value - a.value)
        .map((r) => (
          <View key={r.key} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <T step="12" tone="text3" numberOfLines={1} style={{ width: 92 }}>
              {r.label}
            </T>
            <HBar value={r.value / total} height={4} />
            <T step="code" tone="text2" style={{ width: 62, textAlign: "right" }}>
              {fmtCount(r.value)}
            </T>
          </View>
        ))}
    </View>
  )
}

function aggregate(sessions: AgentUsageSessionSummary[]) {
  const totals: Record<string, number> = {}
  let withBreakdown = 0
  let unmeasured = 0
  for (const s of sessions) {
    if (isUsageUnmeasured(s)) unmeasured += 1
    if (!s.tokenBreakdown) continue
    withBreakdown += 1
    for (const c of CATEGORIES)
      totals[c.key] = (totals[c.key] ?? 0) + (s.tokenBreakdown[c.key] || 0)
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0)
  // "without" splits honestly (P3): a session whose usage was never measured
  // CANNOT have a breakdown (the scaler needs real input tokens) — that is a
  // telemetry gap, not a provider that withholds per-category tokens.
  return {
    totals,
    grand,
    withBreakdown,
    without: sessions.length - withBreakdown,
    unmeasured,
    noBreakdownMeasured: sessions.length - withBreakdown - unmeasured,
  }
}

export function TokensPanel({
  sessions,
  atFetchLimit = false,
}: {
  sessions: AgentUsageSessionSummary[]
  atFetchLimit?: boolean
}) {
  const c = useColors()
  const agg = useMemo(() => aggregate(sessions), [sessions])

  if (sessions.length === 0) {
    return <PanelNote>No sessions in this range.</PanelNote>
  }
  if (agg.withBreakdown === 0) {
    return (
      <PanelNote tone="warn">
        {agg.unmeasured === sessions.length
          ? `Token usage wasn't measured for any of the ${sessions.length} sessions in this range (they predate the telemetry fix, or their provider doesn't report usage), so no input composition exists.`
          : `No input composition for these ${sessions.length} sessions: ${agg.unmeasured} had no usage measured (telemetry gap) and ${agg.noBreakdownMeasured} reported totals without per-category tokens (provider gap).`}
      </PanelNote>
    )
  }

  const rows = CATEGORIES.map((c) => ({ ...c, value: agg.totals[c.key] ?? 0 })).sort(
    (a, b) => b.value - a.value,
  )

  return (
    <SectionCard title="Input composition">
      <StatRow>
        <Stat
          label="Total tokens"
          value={fmtCount(agg.grand)}
          sub={`${agg.withBreakdown} sessions with breakdown`}
        />
        {agg.unmeasured > 0 ? (
          <Stat
            label="Not measured"
            value={fmtCount(agg.unmeasured)}
            sub="sessions (telemetry gap)"
            color={c.tint.a.tx}
          />
        ) : null}
        {agg.noBreakdownMeasured > 0 ? (
          <Stat
            label="No breakdown"
            value={fmtCount(agg.noBreakdownMeasured)}
            sub="sessions (provider gap)"
            color={c.tint.a.tx}
          />
        ) : null}
      </StatRow>
      {atFetchLimit ? (
        <PanelNote>{`Computed over the ${sessions.length} most recent sessions in the range.`}</PanelNote>
      ) : null}
      <View style={{ gap: 10, marginTop: 8 }}>
        {rows.map((r) => {
          const frac = agg.grand > 0 ? r.value / agg.grand : 0
          return (
            <BarRow
              key={r.key}
              label={r.label}
              value={frac}
              valueText={fmtCount(r.value)}
              pctText={`${(frac * 100).toFixed(0)}%`}
            />
          )
        })}
      </View>
    </SectionCard>
  )
}
