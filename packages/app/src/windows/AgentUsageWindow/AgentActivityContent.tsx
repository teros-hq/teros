/**
 * Agent Activity — the monitoring suite's operational cockpit. A `Page` on the
 * sheet: the shared MonitoringHeader (eyebrow + serif title + view chips +
 * period controls), a strip of Stat cards, the FilterBar card and PTabs that
 * switch between six detail views (Overview / Quota / Cache / Tokens / Tools /
 * Health) reusing the shared monitoring primitives and the recovered pure
 * logic (metrics / quota / cache). Every panel degrades HONESTLY on a real data
 * gap — it says "not measured for this provider", never a fabricated 0.
 *
 * Composes the same backend actions the Hub / Model Health use plus the ones
 * the advanced views need (tool-executions, health, directory) — no new action.
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
  SegmentedTabs,
  type SegmentTab,
  Sparkline,
  StatusDot,
  type Series,
  TimeSeriesChart,
  aggregateBucketsByTime,
  bucketLabel,
  fillSeriesBuckets,
  fillTimeBuckets,
  filterBucketsByProvider,
  providerCountsFromBuckets,
  fmtCount,
  fmtInt,
  fmtUSD,
  pctDeltaOverTime,
  shortModel,
  statusMeta,
  unitForPeriodMs,
  useAutoRefresh,
} from "../../components/monitoring"
import { FullscreenLoader } from "../../components/ui"
import { useColors } from "../../components/mca/primitives/useColors"
import { Dot } from "../../components/ui/ds/Badge"
import { Btn, ChipBtn, IconBtn } from "../../components/ui/ds/Buttons"
import { Page } from "../../components/ui/ds/Page"
import { T } from "../../components/ui/ds/Text"
import type {
  AgentUsageBucket,
  AgentUsageHealthResponse,
  AgentUsageProvider,
  AgentUsageQueryParams,
  AgentUsageSessionSummary,
  AgentUsageTriggerKind,
  ModelHealthHourBucket,
  ToolExecutionSummary,
} from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import {
  errorRateLevel,
  type HealthLevel,
  latencyLevel,
  worseLevel,
} from "../ModelHealthWindow/format"
import { ModelTable } from "../shared/ModelTable"
import { useModelHealthData } from "../ModelHealthWindow/hooks/useModelHealthData"
import { cacheMetrics } from "./cache"
import { CachePanel } from "./components/CachePanel"
import { FilterBar } from "./components/FilterBar"
import { HealthPanel } from "./components/HealthPanel"
import { QuotaPanel } from "./components/QuotaPanel"
import { ToolsPanel } from "./components/ToolsPanel"
import { BreakdownMini, TokensPanel } from "./components/TokensPanel"
import { relativeTime } from "./formatters"
import { useDirectory } from "./hooks/useDirectory"
import { useFilters } from "./hooks/useFilters"
import { quotaSnapshot } from "./quota"

type Period = "1h" | "24h" | "7d" | "30d"
const PERIODS: { value: Period; label: string; ms: number }[] = [
  { value: "1h", label: "1 h", ms: 3_600_000 },
  { value: "24h", label: "24 h", ms: 86_400_000 },
  { value: "7d", label: "7 d", ms: 7 * 86_400_000 },
  { value: "30d", label: "30 d", ms: 30 * 86_400_000 },
]

/**
 * Page size for the sessions/tools lists — the panels derived from them state
 * this cap instead of silently computing over "the most recent 50" (N7).
 */
const FETCH_LIMIT = 50

type TabKey = "overview" | "quota" | "cache" | "tokens" | "tools" | "health"
const TABS: SegmentTab[] = [
  { key: "overview", label: "Overview", icon: "squares-four" },
  { key: "quota", label: "Quota", icon: "hourglass" },
  { key: "cache", label: "Cache", icon: "database" },
  { key: "tokens", label: "Tokens", icon: "coins" },
  { key: "tools", label: "Tools", icon: "wrench" },
  { key: "health", label: "Health", icon: "heartbeat" },
]

const modelKey = (m: { actualProvider: string; modelId: string }) =>
  `${m.actualProvider}::${m.modelId}`

/** Per-bucket series → top-7 model series + Other (muted), stable colors. */
function toSeries(
  buckets: ModelHealthHourBucket[],
  unit: BucketUnit,
  withDate: boolean,
  otherColor: string,
): { series: Series[]; labels: string[] } {
  const totals = new Map<string, number>()
  const label = new Map<string, string>()
  for (const b of buckets) {
    for (const m of b.models) {
      const k = modelKey(m)
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
    values: buckets.map((b) => b.models.find((m) => modelKey(m) === k)?.requestCount ?? 0),
  }))
  const other = buckets.map((b) =>
    b.models.filter((m) => !topSet.has(modelKey(m))).reduce((a, m) => a + m.requestCount, 0),
  )
  if (other.some((v) => v > 0))
    series.push({ key: "other", label: "Other", color: otherColor, values: other })
  return { series, labels }
}

export type AgentActivityProps = {
  /** Initial period, propagated from a Hub drill so the view keeps it (A5.4). */
  initialPeriod?: Period
  /** Fixed range from a chart-bar drill (A5.3) — overrides the sliding period until the user picks one. */
  initialFrom?: string
  initialTo?: string
}

export function AgentActivityContent({
  initialPeriod,
  initialFrom,
  initialTo,
}: AgentActivityProps) {
  const c = useColors()
  const client = getTerosClient()
  const openWindow = useTilingStore((s) => s.openWindow)
  const nav = (t: MonitoringTarget) => openWindow(t, { initialPeriod: period }, false)
  const drillTrace = (sessionUsageId: string) =>
    openWindow("session-trace", { sessionUsageId }, false)

  const [period, setPeriod] = useState<Period>(initialPeriod ?? "24h")
  // A chart-bar drill fixes the range to that bucket; picking a period preset
  // clears the override and returns to the sliding window (A5.3/TER-672).
  const [override, setOverride] = useState<{ from: string; to: string } | null>(
    initialFrom && initialTo ? { from: initialFrom, to: initialTo } : null,
  )
  const [tab, setTab] = useState<TabKey>("overview")
  const [showInternalIds, setShowInternalIds] = useState(false)
  // Sliding window (P1/N2): every tick recomputes `to = now`, so the range
  // follows the clock and every fetch downstream reloads.
  const { tick, bump } = useAutoRefresh()

  const { filters, setFilter, clearAll, hasAnyActive } = useFilters()
  const directory = useDirectory(client, {
    userId: filters.userId,
    agentId: filters.agentId,
    workspaceId: filters.workspaceId,
  })

  const range = useMemo(() => {
    // Drill override: a FIXED bucket range from the Hub chart, not sliding.
    if (override) {
      const ms = new Date(override.to).getTime() - new Date(override.from).getTime()
      return {
        from: override.from,
        to: override.to,
        unit: unitForPeriodMs(ms) as BucketUnit,
        withDate: ms > 2 * 86_400_000,
      }
    }
    const opt = PERIODS.find((p) => p.value === period) ?? PERIODS[1]!
    const to = new Date()
    return {
      from: new Date(to.getTime() - opt.ms).toISOString(),
      to: to.toISOString(),
      // Adaptive granularity (P5): 7d/30d switch to day buckets — 720 hourly
      // bars are sub-pixel and their labels carried no date.
      unit: unitForPeriodMs(opt.ms) as BucketUnit,
      withDate: opt.ms > 2 * 86_400_000,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick slides the window to now
  }, [period, tick, override])

  /** Shared filter payload sent to every data fetch (empty slots omitted). */
  const queryFilters = useMemo<AgentUsageQueryParams>(
    () => ({
      from: range.from,
      to: range.to,
      userId: filters.userId || undefined,
      agentId: filters.agentId || undefined,
      workspaceId: filters.workspaceId || undefined,
      provider: (filters.provider || undefined) as AgentUsageProvider | undefined,
      triggerKind: (filters.triggerKind || undefined) as AgentUsageTriggerKind | undefined,
    }),
    [range, filters],
  )

  // KPI buckets are fetched WITHOUT the provider filter: the rows carry
  // groupKey.provider, so the chip filter applies client-side EXACTLY while the
  // chips still see every provider active in range (no feedback loop where the
  // selected chip hides the others). P4, 2026-07-07 audit.
  const bucketFilters = useMemo<AgentUsageQueryParams>(() => {
    const { provider: _provider, ...rest } = queryFilters
    return rest
  }, [queryFilters])

  const { models, series, loading, refreshing, error } = useModelHealthData({
    client,
    range,
    groupBy: range.unit,
    userId: filters.userId || undefined,
    agentId: filters.agentId || undefined,
    workspaceId: filters.workspaceId || undefined,
    provider: (filters.provider || undefined) as AgentUsageProvider | undefined,
  })
  const [buckets, setBuckets] = useState<AgentUsageBucket[]>([])
  const [quotaBuckets, setQuotaBuckets] = useState<AgentUsageBucket[]>([])
  const [sessions, setSessions] = useState<AgentUsageSessionSummary[]>([])
  const [tools, setTools] = useState<ToolExecutionSummary[]>([])
  const [health, setHealth] = useState<AgentUsageHealthResponse | null>(null)

  useEffect(() => {
    let alive = true
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const monthEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString()
    // filters minus the time range, reused for the calendar-month quota fetch.
    const { from: _f, to: _t, ...scope } = queryFilters

    client.admin
      .agentUsageTokensPerHour({ ...bucketFilters, groupBy: range.unit, timeMetric: "agentActive" })
      .then((r) => alive && setBuckets(r.buckets ?? []))
      .catch(() => alive && setBuckets([]))
    client.admin
      .agentUsageTokensPerHour({
        ...scope,
        from: monthStart,
        to: monthEnd,
        groupBy: "day",
        timeMetric: "agentActive",
        limit: 500,
      })
      .then((r) => alive && setQuotaBuckets(r.buckets ?? []))
      .catch(() => alive && setQuotaBuckets([]))
    client.admin
      .listAgentUsageSessions({ ...queryFilters, limit: FETCH_LIMIT, skip: 0 })
      .then((r) => alive && setSessions(r.items))
      .catch(() => alive && setSessions([]))
    client.admin
      .listToolExecutions({ ...queryFilters, limit: FETCH_LIMIT, skip: 0 })
      .then((r) => alive && setTools(r.items))
      .catch(() => alive && setTools([]))
    client.admin
      .agentUsageHealth()
      .then((r) => alive && setHealth(r))
      .catch(() => alive && setHealth(null))
    return () => {
      alive = false
    }
  }, [client, queryFilters, range.unit])

  const kpi = useMemo(() => {
    // ONE point per time bucket (P7): the raw rows come per (bucket × groupKey)
    // — up to 9 per hour — which made sparklines multi-point-per-hour and split
    // the trend halves by row count. Dense fill (N6) keeps the axis uniform so
    // a quiet hour reads as zero, not as an invisible gap.
    const rows = filterBucketsByProvider(buckets, filters.provider || undefined)
    const points = fillTimeBuckets(aggregateBucketsByTime(rows), range.from, range.to, range.unit)
    const hours = points.map((b) => b.activeHours)
    const cost = points.map((b) => b.costUsd)
    const toks = points.map((b) => b.totalTokens)
    const sess = points.map((b) => b.sessionCount)
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    return {
      hours,
      cost,
      toks,
      sess,
      totalHours: sum(hours),
      totalCost: sum(cost),
      totalTokens: sum(toks),
      totalSessions: sum(sess),
      dHours: pctDeltaOverTime(hours),
      dCost: pctDeltaOverTime(cost),
      dTokens: pctDeltaOverTime(toks),
      dSess: pctDeltaOverTime(sess),
    }
  }, [buckets, range, filters.provider])

  const providerCounts = useMemo(() => providerCountsFromBuckets(buckets), [buckets])
  const totalChipSessions = useMemo(
    () => providerCounts.reduce((a, [, n]) => a + n, 0),
    [providerCounts],
  )

  // Filters the backend can't apply — say so instead of pretending (N4).
  const filterCaveats: string[] = []
  if (filters.triggerKind)
    filterCaveats.push(
      "Trigger filter applies to the Sessions list only (KPIs, charts and tools don't carry that dimension).",
    )
  if (filters.provider) filterCaveats.push("Provider filter doesn't apply to tool executions.")
  const chart = useMemo(() => {
    const dense = fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({
      hourBucket: iso,
      models: [],
    }))
    return toSeries(dense, range.unit, range.withDate, c.text3)
  }, [series, range, c.text3])
  const quota = useMemo(() => quotaSnapshot(quotaBuckets, directory), [quotaBuckets, directory])
  const cache = useMemo(
    () => cacheMetrics(sessions, directory.agentIdToName),
    [sessions, directory.agentIdToName],
  )
  const sessionsAtLimit = sessions.length >= FETCH_LIMIT
  const toolsAtLimit = tools.length >= FETCH_LIMIT

  // Real status for the header badge (N3): worst latency/error level across
  // the loaded models — same rule as the Hub. The header previously showed a
  // hardcoded green "All systems healthy" while the Hub said Critical.
  const globalLevel = useMemo<HealthLevel>(
    () =>
      models.reduce<HealthLevel>(
        (acc, m) =>
          worseLevel(
            acc,
            worseLevel(
              latencyLevel("latency", m.latency.p95, m.modelId),
              errorRateLevel(m.errorRate),
            ),
          ),
        "ok",
      ),
    [models],
  )

  const sessionColumns: Column<AgentUsageSessionSummary>[] = [
    {
      key: "started",
      header: "Started",
      width: 92,
      align: "left",
      color: () => c.text3,
      render: (s) => relativeTime(s.startedAt),
    },
    {
      key: "agent",
      header: "Agent · User",
      width: 190,
      flex: 2,
      align: "left",
      render: (s) => (
        <View style={{ minWidth: 0, flex: 1 }}>
          <T step="sm" numberOfLines={1}>
            {showInternalIds ? s.agentId : (directory.agentIdToName.get(s.agentId) ?? s.agentId)}
          </T>
          <T step="12" tone="text3" numberOfLines={1}>
            {showInternalIds ? s.userId : (directory.userIdToName.get(s.userId) ?? s.userId)} ·{" "}
            {s.triggerKind} · #{s.channelId.replace(/^ch_(demo_)?/, "")}
          </T>
        </View>
      ),
    },
    {
      key: "model",
      header: "Provider · Model",
      width: 210,
      flex: 1,
      align: "left",
      render: (s) => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <Dot color={seriesColor(`${s.provider}::${s.modelId}`)} size={8} />
          <T step="code" tone="text2" numberOfLines={1} style={{ flexShrink: 1 }}>
            {s.provider} · {shortModel(s.modelId)}
          </T>
        </View>
      ),
    },
    {
      key: "turns",
      header: "Turns",
      width: 72,
      align: "right",
      mono: true,
      render: (s) => fmtInt(s.llmCallCount),
    },
    // usagePartial → the provider never reported usage: "—", not a fake 0 (N8).
    {
      key: "tokens",
      header: "Tokens",
      width: 92,
      align: "right",
      mono: true,
      render: (s) => (s.usagePartial ? "—" : fmtCount(s.totalTokens)),
    },
    {
      key: "cost",
      header: "Cost",
      width: 84,
      align: "right",
      mono: true,
      render: (s) => (s.usagePartial ? "—" : fmtUSD(s.costUsd)),
    },
    {
      key: "hrs",
      header: "Agent-hrs",
      width: 92,
      align: "right",
      mono: true,
      color: () => c.text3,
      render: (s) => (s.durationMs == null ? "—" : (s.durationMs / 3_600_000).toFixed(2)),
    },
    {
      key: "status",
      header: "Status",
      width: 120,
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
  ]

  /** Expanded row detail — internal ids, drill to trace, per-session breakdown. */
  const renderSessionDetail = (s: AgentUsageSessionSummary) => (
    <>
      {showInternalIds ? (
        <T step="code" tone="text3" selectable>
          {s.sessionUsageId}
          {s.parentSessionUsageId ? ` · parent: ${s.parentSessionUsageId}` : ""}
          {s.actualModel ? ` · actualModel: ${s.actualModel}` : ""}
        </T>
      ) : null}
      {s.errorMessage ? (
        <T step="code" color={c.tint.r.tx} selectable>
          {s.errorMessage}
        </T>
      ) : null}
      <View style={{ flexDirection: "row" }}>
        <Btn
          size="sm"
          variant="primary"
          iconRight="arrow-right"
          onPress={() => drillTrace(s.sessionUsageId)}
          {...({ "aria-label": `Open session trace for ${s.sessionUsageId}` } as any)}
        >
          View trace
        </Btn>
      </View>
      {s.tokenBreakdown ? (
        <BreakdownMini breakdown={s.tokenBreakdown} />
      ) : (
        <T step="12" tone="text3">
          {s.usagePartial
            ? "Usage wasn't measured for this session (the provider didn't report token counts) — tokens/cost show as “—”."
            : "No token breakdown for this session (the provider didn't report per-category tokens)."}
        </T>
      )}
    </>
  )

  if (loading) return <FullscreenLoader />

  const up = c.tint.g.tx
  const down = c.tint.a.tx

  return (
    <Page>
      <MonitoringHeader
        title="Agent Activity"
        activeView="activity"
        statusLevel={globalLevel === "ok" ? "ok" : globalLevel === "warn" ? "degraded" : "error"}
        onNavigate={nav}
        controls={
          <>
            {PERIODS.map((p) => (
              <ChipBtn
                key={p.value}
                mono
                on={period === p.value && !override}
                onPress={() => {
                  setPeriod(p.value)
                  setOverride(null)
                }}
              >
                {p.label}
              </ChipBtn>
            ))}
            <IconBtn
              plain
              sm
              icon="arrows-clockwise"
              disabled={refreshing}
              onPress={bump}
              title="Refresh"
              {...({ "aria-label": "Refresh" } as any)}
            />
            <T step="codenote" tone="text3">
              auto 60s · {new Date(range.to).toLocaleTimeString("en-US", { hour12: false })}
            </T>
          </>
        }
      />

      <View style={{ gap: 16 }}>
        <KpiStrip>
          <KpiTile
            icon="clock"
            label="Agent-hours"
            value={kpi.totalHours >= 1 ? kpi.totalHours.toFixed(1) : kpi.totalHours.toFixed(2)}
            unit={`h · ${period}`}
            delta={kpi.dHours?.text}
            deltaColor={kpi.dHours?.up ? up : down}
            sparkline={kpi.hours.length > 1 ? <Sparkline values={kpi.hours} /> : undefined}
          />
          <KpiTile
            icon="pulse"
            label="Sessions"
            value={fmtInt(kpi.totalSessions)}
            unit={period}
            delta={kpi.dSess?.text}
            deltaColor={kpi.dSess?.up ? up : down}
            sparkline={kpi.sess.length > 1 ? <Sparkline values={kpi.sess} /> : undefined}
          />
          <KpiTile
            icon="coins"
            label="Tokens"
            value={fmtCount(kpi.totalTokens)}
            unit={period}
            delta={kpi.dTokens?.text}
            deltaColor={kpi.dTokens?.up ? up : down}
            sparkline={kpi.toks.length > 1 ? <Sparkline values={kpi.toks} /> : undefined}
          />
          <KpiTile
            icon="currency-dollar"
            label="Cost"
            value={fmtUSD(kpi.totalCost)}
            unit={period}
            delta={kpi.dCost?.text}
            deltaColor={down}
            sparkline={kpi.cost.length > 1 ? <Sparkline values={kpi.cost} /> : undefined}
          />
        </KpiStrip>

        <FilterBar
          filters={filters}
          setFilter={setFilter}
          clearAll={clearAll}
          hasAnyActive={hasAnyActive}
          directory={directory}
          providerCounts={providerCounts}
          totalCount={totalChipSessions}
          showInternalIds={showInternalIds}
          onToggleIds={() => setShowInternalIds((v) => !v)}
        />

        {filterCaveats.length > 0 ? (
          <View style={{ gap: 2 }}>
            {filterCaveats.map((caveat) => (
              <T key={caveat} step="12" tone="text3">
                {caveat}
              </T>
            ))}
          </View>
        ) : null}

        <View style={{ flexDirection: "row" }}>
          <SegmentedTabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
        </View>

        {error ? (
          <T step="sm" color={c.tint.a.tx}>
            {error}
          </T>
        ) : null}

        {tab === "overview" ? (
          <>
            {chart.series.length > 0 ? (
              <SectionCard
                title="Requests by model"
                right={
                  <T step="codenote" tone="text3">
                    {period} · tap a bar
                  </T>
                }
              >
                <TimeSeriesChart
                  series={chart.series}
                  labels={chart.labels}
                  unit="req"
                  format={fmtInt}
                />
              </SectionCard>
            ) : null}

            <SectionCard
              title="By model"
              right={
                <T step="12" tone="text3">
                  reliability by provider × model
                </T>
              }
            >
              {models.length > 0 ? (
                <ModelTable models={models} />
              ) : (
                <T step="sm" tone="text3">
                  No model activity in this range.
                </T>
              )}
            </SectionCard>

            <SectionCard
              title="Sessions"
              right={
                <T step="12" tone="text3">
                  {sessionsAtLimit ? `${FETCH_LIMIT} most recent (more exist) · ` : ""}tap a row for
                  details · trace inside
                </T>
              }
            >
              {sessions.length > 0 ? (
                <DataTable
                  columns={sessionColumns}
                  rows={sessions}
                  rowKey={(s) => s.sessionUsageId}
                  renderExpanded={renderSessionDetail}
                />
              ) : (
                <T step="sm" tone="text3">
                  No sessions in this range.
                </T>
              )}
            </SectionCard>
          </>
        ) : null}

        {tab === "quota" ? <QuotaPanel quota={quota} showInternalIds={showInternalIds} /> : null}
        {tab === "cache" ? <CachePanel cache={cache} atFetchLimit={sessionsAtLimit} /> : null}
        {tab === "tokens" ? (
          <TokensPanel sessions={sessions} atFetchLimit={sessionsAtLimit} />
        ) : null}
        {tab === "tools" ? (
          <ToolsPanel
            tools={tools}
            showInternalIds={showInternalIds}
            onDrill={drillTrace}
            atFetchLimit={toolsAtLimit}
            directory={directory}
          />
        ) : null}
        {tab === "health" ? <HealthPanel health={health} /> : null}
      </View>
    </Page>
  )
}
