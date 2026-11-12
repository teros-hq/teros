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

import { seriesColor } from "@teros/shared"
import { useEffect, useMemo, useState } from "react"
import { View } from "react-native"
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
  shortModel,
  statusMeta,
  unitForPeriodMs,
  useAutoRefresh,
} from "../../components/monitoring"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors } from "../../components/mca/primitives/colors"
import { FullscreenLoader } from "../../components/ui"
import {
  Badge,
  Card,
  ChipBtn,
  EmptyState,
  IconBtn,
  Page,
  Ph,
  T,
  Tile,
  type TileTone,
} from "../../components/ui/ds"
import type {
  AgentUsageBucket,
  AgentUsageSessionSummary,
  ModelHealthHourBucket,
} from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useDirectory } from "../AgentUsageWindow/hooks/useDirectory"
import {
  errorRateLevel,
  type HealthLevel,
  latencyLevel,
  LEVEL_LABELS,
  worseLevel,
} from "../ModelHealthWindow/format"
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
  const topKeys = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map((e) => e[0])
  const topSet = new Set(topKeys)
  const labels = buckets.map((b) => bucketLabel(b.hourBucket, unit, withDate))
  const series: Series[] = topKeys.map((k) => ({
    key: k,
    label: label.get(k) ?? k,
    color: seriesColor(k),
    values: buckets.map((b) => b.models.find((m) => key(m) === k)?.requestCount ?? 0),
  }))
  const other = buckets.map((b) =>
    b.models.filter((m) => !topSet.has(key(m))).reduce((a, m) => a + m.requestCount, 0),
  )
  if (other.some((v) => v > 0))
    series.push({ key: "other", label: "Other", color: semanticColors.text3, values: other })
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

  const { models, series, periodMinutes, loading, refreshing, error } = useModelHealthData({
    client,
    range,
    groupBy: range.unit,
  })
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
    const points = fillTimeBuckets(
      aggregateBucketsByTime(buckets),
      range.from,
      range.to,
      range.unit,
    )
    const cost = points.map((b) => b.costUsd)
    const hours = points.map((b) => b.activeHours)
    const totalCost = cost.reduce((a, b) => a + b, 0)
    const totalHours = hours.reduce((a, b) => a + b, 0)
    const denseSeries = fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({
      hourBucket: iso,
      models: [],
    }))
    const thrSeries = denseSeries.map((bk) => bk.models.reduce((a, m) => a + m.requestCount, 0))
    const errSeries = denseSeries.map((bk) => {
      const req = bk.models.reduce((a, m) => a + m.requestCount, 0)
      const err = bk.models.reduce(
        (a, m) => a + (m.statusCounts.errored ?? 0) + (m.statusCounts.timed_out ?? 0),
        0,
      )
      return req > 0 ? err / req : 0
    })
    // Per-provider worst level → "N/M providers OK".
    const provLevels = new Map<string, HealthLevel>()
    for (const m of models) {
      const lvl = worseLevel(
        latencyLevel("latency", m.latency.p95, m.modelId),
        errorRateLevel(m.errorRate),
      )
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
    const dense = fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({
      hourBucket: iso,
      models: [],
    }))
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
        <View style={{ minWidth: 0, flex: 1 }}>
          <T step="sm" ellipsis>
            {directory.agentIdToName.get(s.agentId) ?? s.agentId}
          </T>
          <T step="code" tone="text3" ellipsis>
            #{s.channelId.replace(/^ch_(demo_)?/, "")}
          </T>
        </View>
      ),
    },
    {
      key: "model",
      header: "Provider · Model",
      width: 220,
      flex: 1,
      align: "left",
      render: (s) => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <View
            style={{
              width: 9,
              height: 9,
              borderRadius: 3,
              backgroundColor: seriesColor(
                `${s.actualProvider ?? s.provider}::${s.actualModel ?? s.modelId}`,
              ),
            }}
          />
          <T step="code" tone="text2" ellipsis style={{ flexShrink: 1 }}>
            {s.provider} · {shortModel(s.modelId)}
          </T>
        </View>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: 128,
      align: "left",
      render: (s) => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <StatusDot status={s.status} size={14} />
          <T step="12" color={statusMeta(s.status).color} numberOfLines={1}>
            {statusMeta(s.status).label}
          </T>
        </View>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      width: 92,
      align: "right",
      mono: true,
      render: (s) => fmtCount(s.totalTokens),
    },
    {
      key: "dur",
      header: "Duration",
      width: 92,
      align: "right",
      mono: true,
      render: (s) => (s.durationMs == null ? "—" : fmtDur(s.durationMs / 1000)),
    },
    {
      key: "cost",
      header: "Cost",
      width: 84,
      align: "right",
      mono: true,
      color: () => c.text3,
      render: (s) => fmtUSD(s.costUsd),
    },
  ]

  if (loading) return <FullscreenLoader />

  return (
    <Page>
      <MonitoringHeader
        title="Monitoring Hub"
        lead="Salud global, gasto y actividad de los agentes en un solo sitio."
        activeView="hub"
        statusLevel={kpis ? HEADER_LEVEL[kpis.global] : "ok"}
        statusText={kpis && kpis.global !== "ok" ? LEVEL_LABELS[kpis.global] : undefined}
        onNavigate={nav}
        controls={
          <>
            {PERIODS.map((p) => (
              <ChipBtn key={p.value} on={period === p.value} onPress={() => setPeriod(p.value)}>
                <T step="code" color={period === p.value ? c.accent : c.text2}>
                  {p.label}
                </T>
              </ChipBtn>
            ))}
            <IconBtn
              icon="arrows-clockwise"
              plain
              sm
              disabled={refreshing}
              onPress={bump}
              title="Refresh"
              accessibilityLabel="Refresh"
              {...({ "aria-label": "Refresh" } as any)}
            />
            <T step="codenote" tone="text3">
              auto 60s · {new Date(range.to).toLocaleTimeString("en-US", { hour12: false })}
            </T>
          </>
        }
      />

      {/* KPI strip */}
      <KpiStrip>
        <KpiTile
          label="Global health"
          value={kpis ? LEVEL_LABELS[kpis.global] : "—"}
          statusColor={
            kpis
              ? statusMeta(
                  kpis.global === "critical" ? "error" : kpis.global === "warn" ? "warn" : "ok",
                ).color
              : c.text3
          }
          statusIcon={
            kpis
              ? kpis.global === "critical"
                ? "x-circle"
                : kpis.global === "warn"
                  ? "warning"
                  : "check-circle"
              : undefined
          }
          sub={kpis ? `${hub.providersOk}/${hub.providerCount} providers OK` : undefined}
        />
        <KpiTile
          icon="currency-dollar"
          label="Spend"
          value={fmtUSD(hub.totalCost)}
          unit={period}
          delta={hub.dCost?.text}
          deltaColor={semanticColors.amber}
          sparkline={
            hub.cost.length > 1 ? (
              <Sparkline values={hub.cost} color={semanticColors.amber} />
            ) : undefined
          }
        />
        <KpiTile
          icon="clock"
          label="Agent-hours"
          value={hub.totalHours >= 1 ? hub.totalHours.toFixed(1) : hub.totalHours.toFixed(2)}
          unit="h"
          delta={hub.dHours?.text}
          deltaColor={hub.dHours?.up ? semanticColors.green : semanticColors.amber}
          sparkline={
            hub.hours.length > 1 ? (
              <Sparkline values={hub.hours} color={semanticColors.green} />
            ) : undefined
          }
        />
        <KpiTile
          icon="warning"
          label="Error rate"
          value={kpis ? fmtPct(kpis.errorRate) : "—"}
          valueColor={kpis ? metricTone("err", kpis.errorRate * 100) : undefined}
          delta={hub.dErr?.text}
          deltaColor={hub.dErr?.up ? semanticColors.red : semanticColors.green}
          sparkline={
            hub.errSeries.length > 1 ? (
              <Sparkline values={hub.errSeries} color={semanticColors.red} />
            ) : undefined
          }
        />
        <KpiTile icon="gauge" label="In-flight" value={fmtInt(inflight.total)} unit="req" />
        <KpiTile
          icon="lightning"
          label="Throughput"
          value={kpis ? fmtInt(kpis.throughput) : "—"}
          unit="req/min"
          delta={hub.dThr?.text}
          deltaColor={hub.dThr?.up ? semanticColors.green : semanticColors.amber}
          sparkline={
            hub.thrSeries.length > 1 ? (
              <Sparkline values={hub.thrSeries} color={c.accent} />
            ) : undefined
          }
        />
      </KpiStrip>

      <View style={{ gap: 16, marginTop: 16 }}>
        {/* drill cards */}
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          <DrillCard
            icon="pulse"
            tone="mint"
            title="Agent Activity"
            desc="Live sessions, tokens, drill to traces"
            metric={`${sessions.length}`}
            metricSub="latest traces shown"
            onPress={() => nav("agent-usage")}
          />
          <DrillCard
            icon="chart-bar"
            tone="amber"
            title="Model Health"
            desc="Reliability by provider × model"
            metric={kpis ? fmtMs(kpis.worstP95) : "—"}
            metricSub="worst p95"
            onPress={() => nav("model-health")}
          />
        </View>

        {error ? (
          <Badge tone="a" icon="warning">
            {error}
          </Badge>
        ) : null}

        {chart.series.length > 0 ? (
          <SectionCard
            title="Requests by model"
            right={
              <T step="codenote" tone="text3">
                {period} · tap a bar to drill
              </T>
            }
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

        <View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <T step="base">Recent traces</T>
            <T step="12" tone="text3">
              each row opens its Session Trace →
            </T>
          </View>
          {sessions.length > 0 ? (
            <DataTable
              columns={sessionColumns}
              rows={sessions}
              rowKey={(s) => s.sessionUsageId}
              onRowPress={(s) =>
                openWindow("session-trace", { sessionUsageId: s.sessionUsageId }, false)
              }
            />
          ) : (
            <Card>
              <EmptyState
                icon="tree-structure"
                title="Sin sesiones recientes"
                text="No recent sessions in this range."
              />
            </Card>
          )}
        </View>
      </View>
    </Page>
  )
}

function DrillCard({
  icon,
  tone,
  title,
  desc,
  metric,
  metricSub,
  onPress,
}: {
  icon: string
  tone: TileTone
  title: string
  desc: string
  metric?: string
  metricSub?: string
  onPress: () => void
}) {
  const c = useColors()
  return (
    <Card pad hov onPress={onPress} style={{ flex: 1, minWidth: 240, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Tile icon={icon} tone={tone} size="sm" />
        <Ph name="arrow-up-right" size={15} color={c.text3} />
      </View>
      <View style={{ gap: 3 }}>
        <T step="base">{title}</T>
        <T step="12" tone="text2">
          {desc}
        </T>
      </View>
      {metric ? (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10 }}>
          <T step="xl">{metric}</T>
          <T step="12" tone="text2" style={{ paddingBottom: 3 }}>
            {metricSub}
          </T>
        </View>
      ) : null}
    </Card>
  )
}
