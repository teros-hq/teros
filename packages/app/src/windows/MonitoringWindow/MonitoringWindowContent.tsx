/**
 * Monitoring Hub (TER — monitoring suite redesign).
 *
 * The single admin entry point for observability. Cross-system KPIs + drill
 * cards into the specialized windows (Usage & Costs, Agent Activity, Model
 * Health) + a "Requests by model" chart + a Recent Traces list that drills into
 * Session Trace. The four windows stopped being separate Navbar entries — they
 * are reached from here and via the shared MonitoringHeader.
 *
 * Composes the reliability data (`useModelHealthData` + in-flight) already used
 * by Model Health, plus recent sessions — no new backend action.
 */

import { Activity, AlertTriangle, BarChart3, Clock, DollarSign, Gauge, RefreshCw, TrendingUp, Zap } from "@tamagui/lucide-icons"
import { seriesColor } from "@teros/shared"
import { useEffect, useMemo, useState } from "react"
import { Button, ScrollView, Text, XStack, YStack } from "tamagui"
import {
  type BucketUnit,
  type Column,
  DataTable,
  KpiStrip,
  KpiTile,
  MonitoringHeader,
  type MonitoringTarget,
  SectionCard,
  Sparkline,
  StatusDot,
  type Series,
  TimeSeriesChart,
  aggregateBucketsByTime,
  bucketLabel,
  fillSeriesBuckets,
  fillTimeBuckets,
  fmtCount,
  fmtDur,
  fmtInt,
  fmtMs,
  fmtPct,
  fmtUSD,
  metricTone,
  pctDeltaOverTime,
  scrollbarThin,
  shortModel,
  statusMeta,
  unitForPeriodMs,
  useAutoRefresh,
} from "../../components/monitoring"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors, surface } from "../../components/mca/primitives/colors"
import { FullscreenLoader } from "../../components/ui"
import type { AgentUsageBucket, AgentUsageSessionSummary, ModelHealthHourBucket } from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useDirectory } from "../AgentUsageWindow/hooks/useDirectory"
import { errorRateLevel, type HealthLevel, latencyLevel, LEVEL_LABELS, worseLevel } from "../ModelHealthWindow/format"
import { useInflightGauge } from "../ModelHealthWindow/hooks/useInflightGauge"
import { useModelHealthData } from "../ModelHealthWindow/hooks/useModelHealthData"
import { bucketRange, drillToAgentUsageProps } from "./drill"

type Period = "1h" | "24h" | "7d" | "30d"
const PERIODS: { value: Period; label: string; ms: number }[] = [
  { value: "1h", label: "1h", ms: 3_600_000 },
  { value: "24h", label: "24h", ms: 86_400_000 },
  { value: "7d", label: "7d", ms: 7 * 86_400_000 },
  { value: "30d", label: "30d", ms: 30 * 86_400_000 },
]

const HEADER_LEVEL: Record<HealthLevel, "ok" | "degraded" | "error"> = {
  ok: "ok",
  warn: "degraded",
  critical: "error",
}

const key = (m: { actualProvider: string; modelId: string }) => `${m.actualProvider}::${m.modelId}`

/**
 * Health RIGHT NOW (A5.1/TER-669): the worst level across the LAST up-to-2
 * buckets of the time-series that actually carry data (the current + previous
 * hour once the live fold lands). A range aggregate would keep yesterday's blip
 * red all day; this reflects what is happening now. `ok` when there is no recent
 * activity — nothing is failing right now, even if the range had a spike earlier.
 */
export function recentHealthLevel(series: ModelHealthHourBucket[]): HealthLevel {
  const withData = series.filter((b) => b.models.length > 0)
  const recent = withData.slice(-2)
  let level: HealthLevel = "ok"
  for (const bk of recent) {
    for (const m of bk.models) {
      level = worseLevel(
        level,
        worseLevel(latencyLevel("latency", m.latency.p95, m.modelId), errorRateLevel(m.errorRate)),
      )
    }
  }
  return level
}

/** Per-bucket series → top-7 model series + Other (gray), stable colors. */
function toSeries(
  buckets: ModelHealthHourBucket[],
  unit: BucketUnit,
  withDate: boolean,
): { series: Series[]; labels: string[] } {
  const totals = new Map<string, number>()
  const label = new Map<string, string>()
  for (const b of buckets) {
    for (const m of b.models) {
      const k = key(m)
      totals.set(k, (totals.get(k) ?? 0) + m.requestCount)
      if (!label.has(k)) label.set(k, shortModel(m.modelId))
    }
  }
  const topKeys = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map((e) => e[0])
  const topSet = new Set(topKeys)
  const labels = buckets.map((b) => bucketLabel(b.hourBucket, unit, withDate))
  const series: Series[] = topKeys.map((k) => ({
    key: k,
    label: label.get(k) ?? k,
    color: seriesColor(k),
    values: buckets.map((b) => b.models.find((m) => key(m) === k)?.requestCount ?? 0),
  }))
  const other = buckets.map((b) => b.models.filter((m) => !topSet.has(key(m))).reduce((a, m) => a + m.requestCount, 0))
  if (other.some((v) => v > 0)) series.push({ key: "other", label: "Other", color: semanticColors.text3, values: other })
  return { series, labels }
}

export type MonitoringWindowProps = {
  /** Optional period from a deep-link (`/admin/monitoring?period=7d`) (A5.5/TER-672). */
  initialPeriod?: string
}

const PERIOD_VALUES: Period[] = ["1h", "24h", "7d", "30d"]
function coercePeriod(p: string | undefined): Period {
  return PERIOD_VALUES.includes(p as Period) ? (p as Period) : "24h"
}

export function MonitoringWindowContent({ initialPeriod }: MonitoringWindowProps) {
  const client = getTerosClient()
  const openWindow = useTilingStore((s) => s.openWindow)
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  const [period, setPeriod] = useState<Period>(coercePeriod(initialPeriod))
  // Sliding window (P1/N2): each tick recomputes `to = now` and reloads all data.
  const { tick, bump } = useAutoRefresh()
  const range = useMemo(() => {
    const opt = PERIODS.find((p) => p.value === period) ?? PERIODS[1]!
    const to = new Date()
    return {
      from: new Date(to.getTime() - opt.ms).toISOString(),
      to: to.toISOString(),
      // Adaptive granularity (P5): 7d/30d switch to day buckets.
      unit: unitForPeriodMs(opt.ms) as BucketUnit,
      withDate: opt.ms > 2 * 86_400_000,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick slides the window to now
  }, [period, tick])

  const { models, series, periodMinutes, loading, refreshing, error } = useModelHealthData({ client, range, groupBy: range.unit })
  const inflight = useInflightGauge(client)
  // Names for the Recent-traces rows (P6) — the Hub rendered raw agent ids.
  const directory = useDirectory(client, {})

  const [sessions, setSessions] = useState<AgentUsageSessionSummary[]>([])
  const [buckets, setBuckets] = useState<AgentUsageBucket[]>([])
  useEffect(() => {
    let alive = true
    client.admin
      .listAgentUsageSessions({ from: range.from, to: range.to, limit: 8, skip: 0 })
      .then((r) => alive && setSessions(r.items))
      .catch(() => alive && setSessions([]))
    client.admin
      .agentUsageTokensPerHour({ from: range.from, to: range.to, groupBy: range.unit })
      .then((r) => alive && setBuckets(r.buckets ?? []))
      .catch(() => alive && setBuckets([]))
    return () => {
      alive = false
    }
  }, [client, range])

  // Carry the current period into the drilled window so the investigation keeps
  // its period instead of resetting to the target's default (A5.4/TER-672).
  const nav = (t: MonitoringTarget) => openWindow(t, { initialPeriod: period }, false)

  const kpis = useMemo(() => {
    if (models.length === 0) return null
    const totalReq = models.reduce((a, m) => a + m.requestCount, 0)
    // A timeout IS a degradation → count it in the error numerator, matching the
    // aggregator's errorRate and the health badge. Using `errored` alone made the
    // Hub KPI read ~1% while the badge saw ~4% on the same data (A3.3/TER-674).
    const totalErrored = models.reduce(
      (a, m) => a + (m.statusCounts.errored ?? 0) + (m.statusCounts.timed_out ?? 0),
      0,
    )
    const worstP95 = Math.max(0, ...models.map((m) => m.latency.p95 ?? 0))
    // Health NOW, not a range aggregate (A5.1): a badge that says "Critical" for
    // a two-hour-old blip trains the operator to ignore it. Compute from the last
    // buckets of the (already-loaded) time-series; the range totals below stay
    // range-wide because they ARE range metrics.
    const global = recentHealthLevel(series)
    const errorRate = totalReq > 0 ? totalErrored / totalReq : 0
    const throughput = periodMinutes > 0 ? totalReq / periodMinutes : 0
    return { totalReq, errorRate, worstP95, global, throughput }
  }, [models, series, periodMinutes])

  const hub = useMemo(() => {
    // ONE dense point per time bucket (P7/N6): the raw rows come per
    // (bucket × groupKey), which made the Spend/Agent-hours sparklines carry
    // several points per hour and the deltas split by row count.
    const points = fillTimeBuckets(aggregateBucketsByTime(buckets), range.from, range.to, range.unit)
    const cost = points.map((b) => b.costUsd)
    const hours = points.map((b) => b.activeHours)
    const totalCost = cost.reduce((a, b) => a + b, 0)
    const totalHours = hours.reduce((a, b) => a + b, 0)
    const denseSeries = fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({ hourBucket: iso, models: [] }))
    const thrSeries = denseSeries.map((bk) => bk.models.reduce((a, m) => a + m.requestCount, 0))
    const errSeries = denseSeries.map((bk) => {
      const req = bk.models.reduce((a, m) => a + m.requestCount, 0)
      const err = bk.models.reduce((a, m) => a + (m.statusCounts.errored ?? 0) + (m.statusCounts.timed_out ?? 0), 0)
      return req > 0 ? err / req : 0
    })
    // Per-provider worst level → "N/M providers OK".
    const provLevels = new Map<string, HealthLevel>()
    for (const m of models) {
      const lvl = worseLevel(latencyLevel("latency", m.latency.p95, m.modelId), errorRateLevel(m.errorRate))
      provLevels.set(m.actualProvider, worseLevel(provLevels.get(m.actualProvider) ?? "ok", lvl))
    }
    return {
      cost,
      hours,
      thrSeries,
      errSeries,
      totalCost,
      totalHours,
      providerCount: provLevels.size,
      providersOk: [...provLevels.values()].filter((l) => l === "ok").length,
      dCost: pctDeltaOverTime(cost),
      dHours: pctDeltaOverTime(hours),
      dThr: pctDeltaOverTime(thrSeries),
      dErr: pctDeltaOverTime(errSeries),
    }
  }, [buckets, series, models, range])

  const chart = useMemo(() => {
    const dense = fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({ hourBucket: iso, models: [] }))
    // `isos` (bucket start per bar) lets a bar tap drill to that bucket's range.
    return { ...toSeries(dense, range.unit, range.withDate), isos: dense.map((d) => d.hourBucket) }
  }, [series, range])

  const sessionColumns: Column<AgentUsageSessionSummary>[] = [
    {
      key: "agent",
      header: "Agent / Channel",
      width: 168,
      flex: 2,
      align: "left",
      render: (s) => (
        <YStack minWidth={0} flex={1}>
          <Text fontSize={13} fontWeight="600" color={c.text} numberOfLines={1}>
            {directory.agentIdToName.get(s.agentId) ?? s.agentId}
          </Text>
          <Text fontSize={11} fontFamily="$mono" color={c.text3} numberOfLines={1}>
            #{s.channelId.replace(/^ch_(demo_)?/, "")}
          </Text>
        </YStack>
      ),
    },
    {
      key: "model",
      header: "Provider · Model",
      width: 220,
      flex: 1,
      align: "left",
      render: (s) => (
        <XStack ai="center" gap={7} flex={1} minWidth={0}>
          <YStack width={9} height={9} borderRadius={3} backgroundColor={seriesColor(`${s.actualProvider ?? s.provider}::${s.actualModel ?? s.modelId}`)} />
          <Text fontSize={12} fontFamily="$mono" color={c.text2} numberOfLines={1} ellipsizeMode="tail">
            {s.provider} · {shortModel(s.modelId)}
          </Text>
        </XStack>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: 128,
      align: "left",
      render: (s) => (
        <XStack ai="center" gap={6}>
          <StatusDot status={s.status} size={14} />
          <Text fontSize={12} fontWeight="560" color={statusMeta(s.status).color} numberOfLines={1}>
            {statusMeta(s.status).label}
          </Text>
        </XStack>
      ),
    },
    { key: "tokens", header: "Tokens", width: 92, align: "right", mono: true, render: (s) => fmtCount(s.totalTokens) },
    { key: "dur", header: "Duration", width: 92, align: "right", mono: true, render: (s) => (s.durationMs == null ? "—" : fmtDur(s.durationMs / 1000)) },
    { key: "cost", header: "Cost", width: 84, align: "right", mono: true, color: () => c.text3, render: (s) => fmtUSD(s.costUsd) },
  ]

  if (loading) return <FullscreenLoader />

  return (
    <YStack flex={1} backgroundColor="$background">
      <MonitoringHeader
        title="Monitoring Hub"
        activeView="hub"
        statusLevel={kpis ? HEADER_LEVEL[kpis.global] : "ok"}
        statusText={kpis && kpis.global !== "ok" ? LEVEL_LABELS[kpis.global] : undefined}
        onNavigate={nav}
        controls={
          <>
            {PERIODS.map((p) => (
              <Button key={p.value} size="$1" theme={period === p.value ? "blue" : undefined} onPress={() => setPeriod(p.value)}>
                {p.label}
              </Button>
            ))}
            <Button size="$1" icon={RefreshCw} disabled={refreshing} onPress={bump} aria-label="Refresh" />
            <Text fontSize={10} fontFamily="$mono" color={c.text3}>
              auto 60s · {new Date(range.to).toLocaleTimeString("en-US", { hour12: false })}
            </Text>
          </>
        }
      />

      {/* KPI strip */}
      <KpiStrip>
        <KpiTile
          label="Global health"
          value={kpis ? LEVEL_LABELS[kpis.global] : "—"}
          statusColor={kpis ? statusMeta(kpis.global === "critical" ? "error" : kpis.global === "warn" ? "warn" : "ok").color : c.text3}
          sub={kpis ? `${hub.providersOk}/${hub.providerCount} providers OK` : undefined}
        />
        <KpiTile
          icon={DollarSign}
          label="Spend"
          value={fmtUSD(hub.totalCost)}
          unit={period}
          delta={hub.dCost?.text}
          deltaColor={semanticColors.amber}
          sparkline={hub.cost.length > 1 ? <Sparkline values={hub.cost} color={semanticColors.amber} /> : undefined}
        />
        <KpiTile
          icon={Clock}
          label="Agent-hours"
          value={hub.totalHours >= 1 ? hub.totalHours.toFixed(1) : hub.totalHours.toFixed(2)}
          unit="h"
          delta={hub.dHours?.text}
          deltaColor={hub.dHours?.up ? semanticColors.green : semanticColors.amber}
          sparkline={hub.hours.length > 1 ? <Sparkline values={hub.hours} color={semanticColors.green} /> : undefined}
        />
        <KpiTile
          icon={AlertTriangle}
          label="Error rate"
          value={kpis ? fmtPct(kpis.errorRate) : "—"}
          valueColor={kpis ? metricTone("err", kpis.errorRate * 100) : undefined}
          delta={hub.dErr?.text}
          deltaColor={hub.dErr?.up ? semanticColors.red : semanticColors.green}
          sparkline={hub.errSeries.length > 1 ? <Sparkline values={hub.errSeries} color={semanticColors.red} /> : undefined}
        />
        <KpiTile icon={Gauge} label="In-flight" value={fmtInt(inflight.total)} unit="req" />
        <KpiTile
          icon={Zap}
          label="Throughput"
          value={kpis ? fmtInt(kpis.throughput) : "—"}
          unit="req/min"
          delta={hub.dThr?.text}
          deltaColor={hub.dThr?.up ? semanticColors.green : semanticColors.amber}
          sparkline={hub.thrSeries.length > 1 ? <Sparkline values={hub.thrSeries} color={semanticColors.indigo} /> : undefined}
        />
      </KpiStrip>

      <ScrollView style={scrollbarThin as never}>
        <YStack padding={24} gap={24}>
          {/* drill cards */}
          <XStack gap={16} flexWrap="wrap">
            <DrillCard icon={Activity} iconBg={isDark ? "rgba(34,197,94,0.14)" : "rgba(34,197,94,0.10)"} iconColor={semanticColors.green} title="Agent Activity" desc="Live sessions, tokens, drill to traces" metric={`${sessions.length}`} metricSub="latest traces shown" onPress={() => nav("agent-usage")} />
            <DrillCard icon={BarChart3} iconBg={isDark ? "rgba(245,158,11,0.14)" : "rgba(245,158,11,0.10)"} iconColor={semanticColors.amber} title="Model Health" desc="Reliability by provider × model" metric={kpis ? fmtMs(kpis.worstP95) : "—"} metricSub="worst p95" onPress={() => nav("model-health")} />
          </XStack>

          {error ? (
            <Text fontSize={13} color={semanticColors.amber}>
              {error}
            </Text>
          ) : null}

          {chart.series.length > 0 ? (
            <SectionCard
              title="Requests by model"
              right={<Text fontSize={11} fontFamily="$mono" color={c.text3}>{period} · tap a bar to drill</Text>}
            >
              <TimeSeriesChart
                series={chart.series}
                labels={chart.labels}
                unit="req"
                format={fmtInt}
                onBarPress={(i) => {
                  const r = bucketRange(chart.isos, i, range.to)
                  if (r) openWindow("agent-usage", drillToAgentUsageProps(r, period), false)
                }}
              />
            </SectionCard>
          ) : null}

          <SectionCard
            title="Recent traces"
            right={<Text fontSize={11} color={c.text3}>each row opens its Session Trace →</Text>}
          >
            {sessions.length > 0 ? (
              <DataTable
                columns={sessionColumns}
                rows={sessions}
                rowKey={(s) => s.sessionUsageId}
                onRowPress={(s) => openWindow("session-trace", { sessionUsageId: s.sessionUsageId }, false)}
              />
            ) : (
              <Text fontSize={13} color={c.text3}>
                No recent sessions in this range.
              </Text>
            )}
          </SectionCard>
        </YStack>
      </ScrollView>
    </YStack>
  )
}

function DrillCard({
  icon: Icon,
  iconBg,
  iconColor,
  title,
  desc,
  metric,
  metricSub,
  onPress,
}: {
  icon: typeof Activity
  iconBg: string
  iconColor: string
  title: string
  desc: string
  metric?: string
  metricSub?: string
  onPress: () => void
}) {
  const c = useColors()
  return (
    <YStack
      flex={1}
      minWidth={240}
      gap={12}
      padding={16}
      borderWidth={1}
      borderColor={c.border}
      borderRadius={12}
      backgroundColor={c.bgCard}
      cursor="pointer"
      hoverStyle={{ borderColor: c.borderStrong, backgroundColor: c.bgCardHover }}
      onPress={onPress}
    >
      <XStack ai="center" jc="space-between">
        <XStack ai="center" jc="center" width={34} height={34} borderRadius={9} backgroundColor={iconBg}>
          <Icon size={18} color={iconColor} />
        </XStack>
        <TrendingUp size={15} color={c.text3} />
      </XStack>
      <YStack gap={3}>
        <Text fontSize={16} fontWeight="640" color={c.text}>
          {title}
        </Text>
        <Text fontSize={12} color={c.text2}>
          {desc}
        </Text>
      </YStack>
      {metric ? (
        <XStack ai="flex-end" gap={10}>
          <Text fontFamily="$mono" fontSize={22} fontWeight="600" color={c.text}>
            {metric}
          </Text>
          <Text fontSize={12} color={c.text2} paddingBottom={3}>
            {metricSub}
          </Text>
        </XStack>
      ) : null}
    </YStack>
  )
}
