/**
 * Agent Activity — the monitoring suite's operational cockpit. A fixed header +
 * KPI strip + FilterBar sit on top; below, SegmentedTabs switch between six
 * detail views (Overview / Quota / Cache / Tokens / Tools / Health) that reuse
 * the shared monitoring primitives and the recovered pure logic (metrics /
 * quota / cache). Every panel degrades HONESTLY on a real data gap — it says
 * "not measured for this provider", never a fabricated 0.
 *
 * Composes the same backend actions the Hub / Model Health use plus the ones
 * the advanced views need (tool-executions, health, directory) — no new action.
 */

import { Activity, Clock, DollarSign, RefreshCw, Zap } from "@tamagui/lucide-icons"
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
  scrollbarThin,
  shortModel,
  statusMeta,
  tokens,
  unitForPeriodMs,
  useAutoRefresh,
} from "../../components/monitoring"
import { FullscreenLoader } from "../../components/ui"
import { colors as semanticColors } from "../../components/mca/primitives/colors"
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
import { errorRateLevel, type HealthLevel, latencyLevel, worseLevel } from "../ModelHealthWindow/format"
import { ModelTable } from "../ModelHealthWindow/ModelHealthWindowContent"
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
  { value: "1h", label: "1h", ms: 3_600_000 },
  { value: "24h", label: "24h", ms: 86_400_000 },
  { value: "7d", label: "7d", ms: 7 * 86_400_000 },
  { value: "30d", label: "30d", ms: 30 * 86_400_000 },
]

/**
 * Page size for the sessions/tools lists — the panels derived from them state
 * this cap instead of silently computing over "the most recent 50" (N7).
 */
const FETCH_LIMIT = 50

type TabKey = "overview" | "quota" | "cache" | "tokens" | "tools" | "health"
const TABS: SegmentTab[] = [
  { key: "overview", label: "Overview" },
  { key: "quota", label: "Quota" },
  { key: "cache", label: "Cache" },
  { key: "tokens", label: "Tokens" },
  { key: "tools", label: "Tools" },
  { key: "health", label: "Health" },
]

const modelKey = (m: { actualProvider: string; modelId: string }) => `${m.actualProvider}::${m.modelId}`

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
      const k = modelKey(m)
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
    values: buckets.map((b) => b.models.find((m) => modelKey(m) === k)?.requestCount ?? 0),
  }))
  const other = buckets.map((b) => b.models.filter((m) => !topSet.has(modelKey(m))).reduce((a, m) => a + m.requestCount, 0))
  if (other.some((v) => v > 0)) series.push({ key: "other", label: "Other", color: semanticColors.muted, values: other })
  return { series, labels }
}

export type AgentActivityProps = {
  /** Initial period, propagated from a Hub drill so the view keeps it (A5.4). */
  initialPeriod?: Period
  /** Fixed range from a chart-bar drill (A5.3) — overrides the sliding period until the user picks one. */
  initialFrom?: string
  initialTo?: string
}

export function AgentActivityContent({ initialPeriod, initialFrom, initialTo }: AgentActivityProps) {
  const client = getTerosClient()
  const openWindow = useTilingStore((s) => s.openWindow)
  const nav = (t: MonitoringTarget) => openWindow(t, { initialPeriod: period }, false)
  const drillTrace = (sessionUsageId: string) => openWindow("session-trace", { sessionUsageId }, false)

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
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
    // filters minus the time range, reused for the calendar-month quota fetch.
    const { from: _f, to: _t, ...scope } = queryFilters

    client.admin
      .agentUsageTokensPerHour({ ...bucketFilters, groupBy: range.unit, timeMetric: "agentActive" })
      .then((r) => alive && setBuckets(r.buckets ?? []))
      .catch(() => alive && setBuckets([]))
    client.admin
      .agentUsageTokensPerHour({ ...scope, from: monthStart, to: monthEnd, groupBy: "day", timeMetric: "agentActive", limit: 500 })
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
      hours, cost, toks, sess,
      totalHours: sum(hours), totalCost: sum(cost), totalTokens: sum(toks), totalSessions: sum(sess),
      dHours: pctDeltaOverTime(hours), dCost: pctDeltaOverTime(cost), dTokens: pctDeltaOverTime(toks), dSess: pctDeltaOverTime(sess),
    }
  }, [buckets, range, filters.provider])

  const providerCounts = useMemo(() => providerCountsFromBuckets(buckets), [buckets])
  const totalChipSessions = useMemo(() => providerCounts.reduce((a, [, n]) => a + n, 0), [providerCounts])

  // Filters the backend can't apply — say so instead of pretending (N4).
  const filterCaveats: string[] = []
  if (filters.triggerKind) filterCaveats.push("Trigger filter applies to the Sessions list only (KPIs, charts and tools don't carry that dimension).")
  if (filters.provider) filterCaveats.push("Provider filter doesn't apply to tool executions.")
  const chart = useMemo(() => {
    const dense = fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({ hourBucket: iso, models: [] }))
    return toSeries(dense, range.unit, range.withDate)
  }, [series, range])
  const quota = useMemo(() => quotaSnapshot(quotaBuckets, directory), [quotaBuckets, directory])
  const cache = useMemo(() => cacheMetrics(sessions, directory.agentIdToName), [sessions, directory.agentIdToName])
  const sessionsAtLimit = sessions.length >= FETCH_LIMIT
  const toolsAtLimit = tools.length >= FETCH_LIMIT

  // Real status for the header badge (N3): worst latency/error level across
  // the loaded models — same rule as the Hub. The header previously showed a
  // hardcoded green "All systems healthy" while the Hub said Critical.
  const globalLevel = useMemo<HealthLevel>(
    () =>
      models.reduce<HealthLevel>(
        (acc, m) => worseLevel(acc, worseLevel(latencyLevel("latency", m.latency.p95, m.modelId), errorRateLevel(m.errorRate))),
        "ok",
      ),
    [models],
  )

  const sessionColumns: Column<AgentUsageSessionSummary>[] = [
    { key: "started", header: "Started", width: 92, align: "left", color: () => tokens.textTertiary, render: (s) => relativeTime(s.startedAt) },
    {
      key: "agent",
      header: "Agent · User",
      width: 190,
      flex: 2,
      align: "left",
      render: (s) => (
        <YStack minWidth={0} flex={1}>
          <Text fontSize={13} fontWeight="600" color={tokens.text} numberOfLines={1}>
            {showInternalIds ? s.agentId : directory.agentIdToName.get(s.agentId) ?? s.agentId}
          </Text>
          <Text fontSize={11} color={tokens.textTertiary} numberOfLines={1}>
            {(showInternalIds ? s.userId : directory.userIdToName.get(s.userId) ?? s.userId)} · {s.triggerKind} · #{s.channelId.replace(/^ch_(demo_)?/, "")}
          </Text>
        </YStack>
      ),
    },
    {
      key: "model",
      header: "Provider · Model",
      width: 210,
      flex: 1,
      align: "left",
      render: (s) => (
        <XStack ai="center" gap={7} flex={1} minWidth={0}>
          <YStack width={9} height={9} borderRadius={3} backgroundColor={seriesColor(`${s.provider}::${s.modelId}`)} />
          <Text fontSize={12} fontFamily="$mono" color={tokens.textSecondary} numberOfLines={1} ellipsizeMode="tail">
            {s.provider} · {shortModel(s.modelId)}
          </Text>
        </XStack>
      ),
    },
    { key: "turns", header: "Turns", width: 72, align: "right", mono: true, render: (s) => fmtInt(s.llmCallCount) },
    // usagePartial → the provider never reported usage: "—", not a fake 0 (N8).
    { key: "tokens", header: "Tokens", width: 92, align: "right", mono: true, render: (s) => (s.usagePartial ? "—" : fmtCount(s.totalTokens)) },
    { key: "cost", header: "Cost", width: 84, align: "right", mono: true, render: (s) => (s.usagePartial ? "—" : fmtUSD(s.costUsd)) },
    { key: "hrs", header: "Agent-hrs", width: 92, align: "right", mono: true, color: () => tokens.textTertiary, render: (s) => (s.durationMs == null ? "—" : (s.durationMs / 3_600_000).toFixed(2)) },
    {
      key: "status",
      header: "Status",
      width: 120,
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
  ]

  /** Expanded row detail — internal ids, drill to trace, per-session breakdown. */
  const renderSessionDetail = (s: AgentUsageSessionSummary) => (
    <>
      {showInternalIds ? (
        <Text fontSize={11} fontFamily="$mono" color={tokens.textTertiary} selectable>
          {s.sessionUsageId}
          {s.parentSessionUsageId ? ` · parent: ${s.parentSessionUsageId}` : ""}
          {s.actualModel ? ` · actualModel: ${s.actualModel}` : ""}
        </Text>
      ) : null}
      {s.errorMessage ? (
        <Text fontSize={12} fontFamily="$mono" color={tokens.error} selectable>
          {s.errorMessage}
        </Text>
      ) : null}
      <XStack>
        <Button size="$2" theme="blue" onPress={() => drillTrace(s.sessionUsageId)} aria-label={`Open session trace for ${s.sessionUsageId}`}>
          View trace →
        </Button>
      </XStack>
      {s.tokenBreakdown ? (
        <BreakdownMini breakdown={s.tokenBreakdown} />
      ) : (
        <Text fontSize={11} color={tokens.textTertiary}>
          {s.usagePartial
            ? "Usage wasn't measured for this session (the provider didn't report token counts) — tokens/cost show as “—”."
            : "No token breakdown for this session (the provider didn't report per-category tokens)."}
        </Text>
      )}
    </>
  )

  if (loading) return <FullscreenLoader />

  return (
    <YStack flex={1} backgroundColor="$background">
      <MonitoringHeader
        title="Agent Activity"
        activeView="activity"
        statusLevel={globalLevel === "ok" ? "ok" : globalLevel === "warn" ? "degraded" : "error"}
        onNavigate={nav}
        controls={
          <>
            {PERIODS.map((p) => (
              <Button key={p.value} size="$1" theme={period === p.value && !override ? "blue" : undefined} onPress={() => { setPeriod(p.value); setOverride(null) }}>
                {p.label}
              </Button>
            ))}
            <Button size="$1" icon={RefreshCw} disabled={refreshing} onPress={bump} aria-label="Refresh" />
            <Text fontSize={10} fontFamily="$mono" color={tokens.textTertiary}>
              auto 60s · {new Date(range.to).toLocaleTimeString("en-US", { hour12: false })}
            </Text>
          </>
        }
      />

      <KpiStrip>
        <KpiTile
          icon={Clock}
          label="Agent-hours"
          value={kpi.totalHours >= 1 ? kpi.totalHours.toFixed(1) : kpi.totalHours.toFixed(2)}
          unit={`h · ${period}`}
          delta={kpi.dHours?.text}
          deltaColor={kpi.dHours?.up ? tokens.success : tokens.warning}
          sparkline={kpi.hours.length > 1 ? <Sparkline values={kpi.hours} color={tokens.success} /> : undefined}
        />
        <KpiTile
          icon={Activity}
          label="Sessions"
          value={fmtInt(kpi.totalSessions)}
          unit={period}
          delta={kpi.dSess?.text}
          deltaColor={kpi.dSess?.up ? tokens.success : tokens.warning}
          sparkline={kpi.sess.length > 1 ? <Sparkline values={kpi.sess} color={tokens.accent} /> : undefined}
        />
        <KpiTile
          icon={Zap}
          label="Tokens"
          value={fmtCount(kpi.totalTokens)}
          unit={period}
          delta={kpi.dTokens?.text}
          deltaColor={kpi.dTokens?.up ? tokens.success : tokens.warning}
          sparkline={kpi.toks.length > 1 ? <Sparkline values={kpi.toks} color={tokens.accent} /> : undefined}
        />
        <KpiTile
          icon={DollarSign}
          label="Cost"
          value={fmtUSD(kpi.totalCost)}
          unit={period}
          delta={kpi.dCost?.text}
          deltaColor={tokens.warning}
          sparkline={kpi.cost.length > 1 ? <Sparkline values={kpi.cost} color={tokens.warning} /> : undefined}
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
        <YStack paddingHorizontal={24} paddingTop={8} gap={2}>
          {filterCaveats.map((c) => (
            <Text key={c} fontSize={11} color={tokens.textTertiary}>
              {c}
            </Text>
          ))}
        </YStack>
      ) : null}

      <XStack paddingHorizontal={24} paddingTop={16}>
        <SegmentedTabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
      </XStack>

      <ScrollView style={scrollbarThin as never}>
        <YStack padding={24} gap={24}>
          {error ? <Text fontSize={13} color={tokens.warning}>{error}</Text> : null}

          {tab === "overview" ? (
            <>
              {chart.series.length > 0 ? (
                <SectionCard title="Requests by model" right={<Text fontSize={11} fontFamily="$mono" color={tokens.textTertiary}>{period} · tap a bar</Text>}>
                  <TimeSeriesChart series={chart.series} labels={chart.labels} unit="req" format={fmtInt} />
                </SectionCard>
              ) : null}

              <SectionCard title="By model" right={<Text fontSize={11} color={tokens.textTertiary}>reliability by provider × model</Text>}>
                {models.length > 0 ? (
                  <ModelTable models={models} />
                ) : (
                  <Text fontSize={13} color={tokens.textTertiary}>No model activity in this range.</Text>
                )}
              </SectionCard>

              <SectionCard title="Sessions" right={<Text fontSize={11} color={tokens.textTertiary}>{sessionsAtLimit ? `${FETCH_LIMIT} most recent (more exist) · ` : ""}tap a row for details · trace inside</Text>}>
                {sessions.length > 0 ? (
                  <DataTable columns={sessionColumns} rows={sessions} rowKey={(s) => s.sessionUsageId} renderExpanded={renderSessionDetail} />
                ) : (
                  <Text fontSize={13} color={tokens.textTertiary}>No sessions in this range.</Text>
                )}
              </SectionCard>
            </>
          ) : null}

          {tab === "quota" ? <QuotaPanel quota={quota} showInternalIds={showInternalIds} /> : null}
          {tab === "cache" ? <CachePanel cache={cache} atFetchLimit={sessionsAtLimit} /> : null}
          {tab === "tokens" ? <TokensPanel sessions={sessions} atFetchLimit={sessionsAtLimit} /> : null}
          {tab === "tools" ? <ToolsPanel tools={tools} showInternalIds={showInternalIds} onDrill={drillTrace} atFetchLimit={toolsAtLimit} directory={directory} /> : null}
          {tab === "health" ? <HealthPanel health={health} /> : null}
        </YStack>
      </ScrollView>
    </YStack>
  )
}
