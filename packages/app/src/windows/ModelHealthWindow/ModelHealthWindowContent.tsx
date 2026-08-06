/**
 * Model Health Window (TER-616 / F1).
 *
 * Admin-only dashboard for proactive degradation detection of the `teros`
 * provider (and any logical provider): latency/TTFT percentiles, error-rate by
 * kind, throughput and success-rate per `actualProvider×modelId` — so Fireworks
 * and Together are distinguishable even behind the same logical provider (C1).
 *
 * Reads `admin-api.agent-usage-model-health` (requireSystemAdmin server-side).
 * On FORBIDDEN it shows the same Shield empty-state pattern as the other admin
 * windows, so the launcher needs no extra client guard.
 *
 * Accessibility: thresholds are icon + text + colour (never colour alone),
 * palette blue/orange (no red/green-only). Loading/empty/error are handled
 * per-window (not a blanked screen).
 */

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  GitBranch,
  Grid3x3,
  Radio,
  RefreshCw,
  Shield,
  ThumbsUp,
  Timer,
  TrendingUp,
  Zap,
} from "@tamagui/lucide-icons"
import { type ReactNode, useMemo, useState } from "react"
import { Button, Paragraph, ScrollView, Text, XStack, YStack } from "tamagui"
import { FullscreenLoader } from "../../components/ui"
import type {
  ModelHealthSummary,
  UpstreamErrorRow,
  UpstreamIndicator,
  UpstreamStatus,
} from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { InflightGauge } from "./components/InflightGauge"
import { LatencyHeatmap } from "./components/LatencyHeatmap"
import { ModelHealthTimeseriesChart } from "./components/ModelHealthTimeseriesChart"
import { PercentileBandChart } from "./components/PercentileBandChart"
import {
  errorRateLevel,
  fallbackLevel,
  formatCount,
  formatMs,
  formatPct,
  formatRate,
  type HealthLevel,
  LEVEL_COLORS,
  LEVEL_LABELS,
  latencyLevel,
  saturationLevel,
  toolErrorLevel,
  truncationLevel,
  worseLevel,
} from "./format"
import { useInflightGauge } from "./hooks/useInflightGauge"
import { useModelHealthData } from "./hooks/useModelHealthData"
import { useUpstreamErrors } from "./hooks/useUpstreamErrors"
import { seriesColor } from "@teros/shared"
import {
  type BucketUnit,
  DataTable,
  type Column,
  MonitoringHeader,
  type MonitoringTarget,
  StatusDot as StatusIcon,
  fillSeriesBuckets,
  metricTone,
  scrollbarThin,
  tokens as mtokens,
  unitForPeriodMs,
  useAutoRefresh,
} from "../../components/monitoring"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors, indicators } from "../../components/mca/primitives/colors"

type Period = "1h" | "24h" | "7d" | "30d"
const PERIODS: { value: Period; label: string; ms: number }[] = [
  { value: "1h", label: "1h", ms: 3_600_000 },
  { value: "24h", label: "24h", ms: 86_400_000 },
  { value: "7d", label: "7d", ms: 7 * 86_400_000 },
  { value: "30d", label: "30d", ms: 30 * 86_400_000 },
]

/** Worst health level across latency p95, ttft p95 and error-rate for one model. */
function modelLevel(m: ModelHealthSummary): HealthLevel {
  return worseLevel(
    worseLevel(latencyLevel("latency", m.latency.p95, m.modelId), latencyLevel("ttft", m.ttft.p95, m.modelId)),
    errorRateLevel(m.errorRate),
  )
}

const LEVEL_STATUS: Record<HealthLevel, string> = { ok: "ok", warn: "warn", critical: "error" }
/** `${provider}::${modelId}` — the stable identity key that colors a model everywhere. */
const modelKey = (m: ModelHealthSummary) => `${m.actualProvider}::${m.modelId}`
const shortModelId = (id: string) => (id.includes("/") ? (id.split("/").pop() ?? id) : id)

/** Shared leading columns (status + model) so the two stacked tables align. */
function leadingColumns(): Column<ModelHealthSummary>[] {
  return [
    {
      key: "status",
      header: "",
      width: 44,
      align: "center",
      render: (m) => <StatusIcon status={LEVEL_STATUS[modelLevel(m)]} size={15} />,
    },
    {
      key: "model",
      header: "Model",
      width: 240,
      align: "left",
      render: (m) => (
        <XStack ai="center" gap={7} minWidth={0} flex={1}>
          <YStack width={9} height={9} borderRadius={3} backgroundColor={seriesColor(modelKey(m))} />
          <Text fontSize={13} fontWeight="560" color={mtokens.text} numberOfLines={1}>
            {shortModelId(m.modelId)}
          </Text>
          <Text
            fontSize={10}
            fontFamily="$mono"
            color={mtokens.textMuted}
            numberOfLines={1}
            ellipsizeMode="tail"
            flex={1}
          >
            {m.actualProvider}
          </Text>
        </XStack>
      ),
    },
  ]
}

const LEVEL_ICON: Record<HealthLevel, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  critical: AlertTriangle,
}

function StatusPill({ level }: { level: HealthLevel }) {
  const Icon = LEVEL_ICON[level]
  const color = LEVEL_COLORS[level]
  return (
    <XStack ai="center" gap={6} aria-label={`Status: ${LEVEL_LABELS[level]}`}>
      <Icon size={16} color={color} />
      <Text fontSize={13} fontWeight="600" color={color}>
        {LEVEL_LABELS[level]}
      </Text>
    </XStack>
  )
}

function KpiTile({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: typeof Activity
  label: string
  value: string
  sub?: string
  color?: string
}) {
  const c = useColors()
  return (
    <YStack
      flex={1}
      minWidth={150}
      gap={4}
      padding={14}
      borderRadius={10}
      backgroundColor={c.bgInner}
      borderColor={c.borderStrong}
      borderWidth={1}
    >
      <XStack ai="center" gap={6}>
        <Icon size={14} color={c.text2} />
        <Text fontSize={11} color={c.text2} textTransform="uppercase" letterSpacing={0.5}>
          {label}
        </Text>
      </XStack>
      <Text fontSize={24} fontWeight="700" color={color ?? c.text}>
        {value}
      </Text>
      {sub ? (
        <Text fontSize={11} color={c.text3}>
          {sub}
        </Text>
      ) : null}
    </YStack>
  )
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Activity
  children: ReactNode
}) {
  const c = useColors()
  return (
    <YStack
      gap={12}
      padding={16}
      borderRadius={12}
      backgroundColor={c.bgInner}
      borderColor={c.borderStrong}
      borderWidth={1}
    >
      <XStack ai="center" gap={8}>
        <Icon size={16} color={semanticColors.indigo} />
        <Text fontSize={14} fontWeight="600" color={c.text}>
          {title}
        </Text>
      </XStack>
      {children}
    </YStack>
  )
}

/**
 * Sub-reason → dot colour for the upstream-errors feed (TER-700). Amber = capacity
 * (self-heals), red = billing/auth (intervention), gray = model config, indigo =
 * account rate-limit. Never colour alone — the label sits next to the dot.
 */
const SUBREASON_COLOR: Record<string, string> = {
  provider_capacity: semanticColors.amber,
  provider_overloaded: semanticColors.amber,
  account_rate_limit: semanticColors.indigo,
  token_rate_limit: semanticColors.indigo,
  provider_billing: semanticColors.red,
  provider_server_error: semanticColors.red,
  auth: semanticColors.red,
  model_unavailable: mtokens.textTertiary,
}

function fmtErrTime(iso?: string): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/**
 * The ops feed of recent upstream provider errors — the ONLY surface that shows
 * the precise cause + the literal message (the user's chat card never does).
 */
function UpstreamErrorsTable({ rows, loading }: { rows: UpstreamErrorRow[]; loading: boolean }) {
  const c = useColors()
  if (loading) {
    return (
      <Text fontSize={12} color={c.text2}>
        Loading…
      </Text>
    )
  }
  if (rows.length === 0) {
    return (
      <Text fontSize={12} color={c.text2}>
        No upstream errors in this window — a healthy signal.
      </Text>
    )
  }
  return (
    <YStack>
      <XStack paddingBottom={8} borderBottomWidth={1} borderColor={c.borderStrong}>
        <Text width={56} fontSize={10} color={c.text3}>
          WHEN
        </Text>
        <Text flex={1.4} fontSize={10} color={c.text3}>
          PROVIDER · MODEL
        </Text>
        <Text flex={1.2} fontSize={10} color={c.text3}>
          SUB-REASON
        </Text>
        <Text flex={2} fontSize={10} color={c.text3}>
          MESSAGE
        </Text>
      </XStack>
      {rows.map((r, i) => (
        <XStack
          key={`${r.time ?? ""}-${i}`}
          paddingVertical={9}
          borderBottomWidth={1}
          borderColor={c.border}
          ai="center"
        >
          <Text width={56} fontSize={11} color={c.text2}>
            {fmtErrTime(r.time)}
          </Text>
          <Text flex={1.4} fontSize={11} fontFamily="$mono" color={c.text2}>
            {r.provider ?? "—"} · {r.model ?? "—"}
          </Text>
          <XStack flex={1.2} ai="center" gap={6}>
            <YStack
              width={7}
              height={7}
              borderRadius={4}
              backgroundColor={SUBREASON_COLOR[r.errorSubReason ?? ""] ?? mtokens.textTertiary}
            />
            <Text fontSize={11} color={c.text2}>
              {r.errorSubReason ?? r.errorKind ?? "—"}
            </Text>
          </XStack>
          <Text flex={2} fontSize={11} fontFamily="$mono" color={c.text2} numberOfLines={1}>
            {r.upstreamMessage ?? "—"}
          </Text>
        </XStack>
      ))}
    </YStack>
  )
}

/** Reusable per-model reliability table (also rendered in Agent Activity's "By model"). */
export function ModelTable({ models }: { models: ModelHealthSummary[] }) {
  const columns: Column<ModelHealthSummary>[] = [
    ...leadingColumns(),
    { key: "req", header: "Req", width: 92, align: "right", mono: true, color: () => mtokens.text, render: (m) => formatCount(m.requestCount) },
    { key: "p50", header: "p50", width: 88, align: "right", mono: true, render: (m) => (m.latency.p50 == null ? "—" : formatMs(m.latency.p50)) },
    {
      key: "p95",
      header: "p95",
      width: 88,
      align: "right",
      mono: true,
      color: (m) => LEVEL_COLORS[latencyLevel("latency", m.latency.p95, m.modelId)],
      render: (m) => (m.latency.p95 == null ? "—" : formatMs(m.latency.p95)),
    },
    {
      key: "p99",
      header: "p99",
      width: 88,
      align: "right",
      mono: true,
      color: () => mtokens.textTertiary,
      // When p99's rank lands in the unbounded overflow bucket the value is a
      // clamp (81920ms), not the real tail → prefix "≥" so it doesn't read as an
      // exact figure for reasoning models >82s (A3.1/TER-674).
      render: (m) => (m.latency.p99 == null ? "—" : `${m.latency.p99Capped ? "≥" : ""}${formatMs(m.latency.p99)}`),
    },
    {
      key: "ttft",
      header: "TTFT p95",
      width: 104,
      align: "right",
      mono: true,
      color: (m) => LEVEL_COLORS[latencyLevel("ttft", m.ttft.p95, m.modelId)],
      render: (m) => (m.ttft.p95 == null ? "—" : formatMs(m.ttft.p95)),
    },
    {
      key: "err",
      header: "Err",
      width: 84,
      align: "right",
      mono: true,
      color: (m) => LEVEL_COLORS[errorRateLevel(m.errorRate)],
      render: (m) => formatPct(m.errorRate),
    },
    {
      key: "success",
      header: "Success",
      width: 96,
      // Absorbs the extra viewport width so the table reaches the window's right
      // edge. Flex ONLY on the last column: the leading columns stay fixed and
      // aligned with QualitySignalsTable stacked below.
      flex: 1,
      align: "right",
      mono: true,
      // null = all-aborted bucket (no measurable success) → neutral "—", never a
      // red 0% (A3.3/TER-674).
      color: (m) => (m.successRate == null ? mtokens.textTertiary : metricTone("success", m.successRate * 100)),
      render: (m) => formatPct(m.successRate),
    },
  ]
  return <DataTable columns={columns} rows={models} rowKey={modelKey} />
}

/**
 * Quality + saturation signals per model (§3.1 + §2.1, R7.3): the proxies that
 * don't fit the latency-centric main table. `—` when a model carries no tool
 * calls (toolErrorRate has no denominator). Thumbs are query-time feedback.
 */
function QualitySignalsTable({ models }: { models: ModelHealthSummary[] }) {
  const columns: Column<ModelHealthSummary>[] = [
    ...leadingColumns(),
    {
      key: "sat",
      header: "Saturation",
      width: 150,
      align: "left",
      render: (m) => {
        const color = LEVEL_COLORS[saturationLevel(m.saturationRate ?? 0)]
        return (
          <XStack ai="center" gap={8} flex={1} minWidth={0}>
            <YStack flex={1} maxWidth={70} height={6} borderRadius={3} backgroundColor={mtokens.bgPress} overflow="hidden">
              <YStack height="100%" width={`${Math.min(100, (m.saturationRate ?? 0) * 100)}%`} backgroundColor={color} borderRadius={3} />
            </YStack>
            <Text fontSize={12} fontFamily="$mono" color={color}>
              {formatPct(m.saturationRate ?? 0)}
            </Text>
          </XStack>
        )
      },
    },
    { key: "fallback", header: "Fallback", width: 100, align: "right", mono: true, color: (m) => LEVEL_COLORS[fallbackLevel(m.fallbackRate ?? 0)], render: (m) => formatPct(m.fallbackRate ?? 0) },
    { key: "truncation", header: "Truncation", width: 108, align: "right", mono: true, color: (m) => (m.truncationRate == null ? mtokens.textTertiary : LEVEL_COLORS[truncationLevel(m.truncationRate)]), render: (m) => formatPct(m.truncationRate) },
    { key: "toolerr", header: "Tool err", width: 96, align: "right", mono: true, color: (m) => LEVEL_COLORS[toolErrorLevel(m.toolErrorRate ?? 0)], render: (m) => (m.toolCallCount ? formatPct(m.toolErrorRate ?? 0) : "—") },
    {
      key: "feedback",
      header: "👍 / 👎",
      width: 138,
      // Last-column flex — same rationale as ModelTable's Success column: the
      // stacked tables keep their shared leading columns aligned.
      flex: 1,
      align: "right",
      render: (m) => {
        const up = m.thumbsUp ?? 0
        const down = m.thumbsDown ?? 0
        const tot = up + down
        if (!tot)
          return (
            <Text fontSize={12} fontFamily="$mono" color={mtokens.textMuted} textAlign="right" width="100%">
              —
            </Text>
          )
        const pct = Math.round((up / tot) * 100)
        return (
          <XStack ai="center" gap={6} jc="flex-end" flex={1}>
            <ThumbsUp size={13} color={metricTone("fb", pct)} />
            <Text fontSize={12} fontFamily="$mono" fontWeight="560" color={metricTone("fb", pct)}>
              {pct}%
            </Text>
            <Text fontSize={10} fontFamily="$mono" color={mtokens.textMuted}>
              {formatCount(tot)}
            </Text>
          </XStack>
        )
      },
    },
  ]
  return <DataTable columns={columns} rows={models} rowKey={modelKey} />
}

const UPSTREAM_INDICATOR_META: Record<UpstreamIndicator, { label: string; level: HealthLevel }> = {
  operational: { label: "Operational", level: "ok" },
  degraded: { label: "Degraded", level: "warn" },
  partial_outage: { label: "Partial outage", level: "warn" },
  major_outage: { label: "Major outage", level: "critical" },
  maintenance: { label: "Maintenance", level: "warn" },
  unknown: { label: "Unknown", level: "ok" },
}

/**
 * Upstream incident badge (R9). Stays QUIET when every upstream is operational
 * or unknown — it only surfaces to explain a spike ("…because Fireworks declared
 * a major outage"). Never colour-alone: icon + provider + status text.
 */
function UpstreamBadge({ status }: { status: UpstreamStatus }) {
  const incidents = (Object.entries(status) as [string, UpstreamIndicator][]).filter(
    ([, ind]) => ind !== "operational" && ind !== "unknown",
  )
  if (incidents.length === 0) return null
  const worst = incidents.reduce<HealthLevel>(
    (acc, [, ind]) => worseLevel(acc, UPSTREAM_INDICATOR_META[ind].level),
    "ok",
  )
  return (
    <XStack
      ai="center"
      gap={6}
      paddingVertical={4}
      paddingHorizontal={10}
      borderRadius={8}
      backgroundColor={indicators.risk.bg}
      borderColor={indicators.risk.border}
      borderWidth={1}
      aria-label={`Upstream incident: ${incidents
        .map(([name, ind]) => `${name} ${UPSTREAM_INDICATOR_META[ind].label}`)
        .join(", ")}`}
    >
      <AlertTriangle size={14} color={LEVEL_COLORS[worst]} />
      <Text fontSize={12} fontWeight="600" color={LEVEL_COLORS[worst]}>
        {incidents
          .map(([name, ind]) => `${name}: ${UPSTREAM_INDICATOR_META[ind].label}`)
          .join(" · ")}
      </Text>
    </XStack>
  )
}

export type ModelHealthWindowProps = {
  /** Initial period propagated from a Hub drill so the view keeps it (A5.4/TER-672). */
  initialPeriod?: Period
}

export function ModelHealthWindowContent({ initialPeriod }: ModelHealthWindowProps) {
  const c = useColors()
  const client = getTerosClient()
  const openWindow = useTilingStore((s) => s.openWindow)
  const nav = (target: MonitoringTarget) => openWindow(target, { initialPeriod: period }, false)
  const [period, setPeriod] = useState<Period>(initialPeriod ?? "24h")
  // Sliding window (P1/N2): each tick recomputes `to = now` and reloads.
  const { tick, bump } = useAutoRefresh()

  const range = useMemo(() => {
    const opt = PERIODS.find((p) => p.value === period)!
    const to = new Date()
    const from = new Date(to.getTime() - opt.ms)
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      // Adaptive granularity (P5): 7d/30d switch to day buckets — the hourly
      // heatmap/volume chart rendered 720 sub-pixel columns at 30d.
      unit: unitForPeriodMs(opt.ms) as BucketUnit,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick slides the window to now
  }, [period, tick])

  const { models, series, bucketTimeZone, periodMinutes, upstreamStatus, loading, refreshing, error } =
    useModelHealthData({
      client,
      range,
      groupBy: range.unit,
    })
  const inflightData = useInflightGauge(client)
  const { rows: upstreamErrors, loading: upstreamLoading } = useUpstreamErrors({ client, range })

  // Uniform time axis (N6): fill the buckets the range expects, so a quiet
  // hour/day is a visible zero instead of an invisible gap.
  const denseSeries = useMemo(
    () => fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({ hourBucket: iso, models: [] })),
    [series, range],
  )

  const kpis = useMemo(() => {
    if (models.length === 0) return null
    const totalReq = models.reduce((a, m) => a + m.requestCount, 0)
    const totalErrored = models.reduce((a, m) => a + (m.statusCounts.errored ?? 0), 0)
    const worstLatencyP95 = Math.max(...models.map((m) => m.latency.p95 ?? 0))
    const worstTtftP95 = Math.max(...models.map((m) => m.ttft.p95 ?? 0))
    const upstreams = new Set(models.map((m) => m.actualProvider)).size
    const global = models.reduce<HealthLevel>((acc, m) => worseLevel(acc, modelLevel(m)), "ok")
    // Request-weighted rates so a low-volume model can't dominate the headline.
    const wSaturated = models.reduce((a, m) => a + (m.saturationRate ?? 0) * m.requestCount, 0)
    const wFallback = models.reduce((a, m) => a + (m.fallbackRate ?? 0) * m.requestCount, 0)
    const thumbsUp = models.reduce((a, m) => a + (m.thumbsUp ?? 0), 0)
    const thumbsDown = models.reduce((a, m) => a + (m.thumbsDown ?? 0), 0)
    return {
      totalReq,
      errorRate: totalReq > 0 ? totalErrored / totalReq : 0,
      worstLatencyP95,
      worstTtftP95,
      upstreams,
      modelCount: models.length,
      global,
      saturationRate: totalReq > 0 ? wSaturated / totalReq : 0,
      fallbackRate: totalReq > 0 ? wFallback / totalReq : 0,
      thumbsUp,
      thumbsDown,
    }
  }, [models])

  // In-flight is a live, range-independent signal — render it even in the empty
  // state, so "no rollups yet, but 2 streams running now" is still visible.
  const inflightCard = (
    <Card title="In-flight LLM streams (live)" icon={Radio}>
      <InflightGauge
        inflight={inflightData.inflight}
        total={inflightData.total}
        capturedAt={inflightData.capturedAt}
        error={inflightData.error}
      />
    </Card>
  )

  return (
    <YStack flex={1} backgroundColor="$background">
      <MonitoringHeader
        title="Model Health"
        activeView="models"
        statusLevel={kpis ? (kpis.global === "ok" ? "ok" : kpis.global === "warn" ? "degraded" : "error") : "ok"}
        onNavigate={nav}
      />
      {/* Controls header (period · refresh · upstream) */}
      <XStack
        ai="center"
        jc="space-between"
        paddingHorizontal={16}
        paddingVertical={12}
        borderBottomColor={c.borderStrong}
        borderBottomWidth={1}
        gap={12}
        flexWrap="wrap"
      >
        <XStack ai="center" gap={10}>
          <Activity size={18} color={semanticColors.indigo} />
          <Text fontSize={16} fontWeight="700" color={c.text}>
            Model Health
          </Text>
          {kpis ? <StatusPill level={kpis.global} /> : null}
          {upstreamStatus ? <UpstreamBadge status={upstreamStatus} /> : null}
        </XStack>
        <XStack ai="center" gap={6}>
          {PERIODS.map((p) => (
            <Button
              key={p.value}
              size="$2"
              theme={period === p.value ? "blue" : undefined}
              onPress={() => setPeriod(p.value)}
            >
              {p.label}
            </Button>
          ))}
          <Button
            size="$2"
            icon={RefreshCw}
            disabled={refreshing}
            onPress={bump}
            aria-label="Refresh"
          />
          <Text fontSize={10} fontFamily="$mono" color={mtokens.textTertiary}>
            auto 60s · {new Date(range.to).toLocaleTimeString("en-US", { hour12: false })}
          </Text>
        </XStack>
      </XStack>

      {loading ? (
        <FullscreenLoader />
      ) : error ? (
        <YStack flex={1} ai="center" jc="center" gap={12} padding={32}>
          {error === "Admin privileges required" ? (
            <Shield size={40} color={semanticColors.orange} />
          ) : (
            <AlertTriangle size={40} color={semanticColors.red} />
          )}
          <Text fontSize={15} fontWeight="600" color={c.text}>
            {error}
          </Text>
          {error === "Admin privileges required" ? (
            <Paragraph fontSize={13} color={c.text2} textAlign="center" maxWidth={420}>
              This window is restricted to system admins (role ∈ admin | super).
            </Paragraph>
          ) : null}
        </YStack>
      ) : models.length === 0 ? (
        <ScrollView flex={1} style={scrollbarThin as never}>
          <YStack gap={16} padding={16}>
            <YStack ai="center" jc="center" gap={10} paddingVertical={32}>
              <Activity size={36} color={c.text3} />
              <Text fontSize={14} color={c.text2}>
                No model activity in the selected period.
              </Text>
            </YStack>
            {inflightCard}
          </YStack>
        </ScrollView>
      ) : (
        <ScrollView flex={1} style={scrollbarThin as never}>
          <YStack gap={16} padding={16}>
            {/* KPI strip */}
            {kpis ? (
              <XStack gap={12} flexWrap="wrap">
                <KpiTile
                  icon={Activity}
                  label="Requests"
                  value={formatCount(kpis.totalReq)}
                  sub={`${kpis.modelCount} models · ${kpis.upstreams} upstreams`}
                />
                <KpiTile
                  icon={TrendingUp}
                  label="Throughput"
                  value={formatRate(periodMinutes > 0 ? kpis.totalReq / periodMinutes : 0)}
                  sub="turns per minute"
                />
                <KpiTile
                  icon={AlertTriangle}
                  label="Error rate"
                  value={formatPct(kpis.errorRate)}
                  color={LEVEL_COLORS[errorRateLevel(kpis.errorRate)]}
                />
                <KpiTile
                  icon={Timer}
                  label="Worst p95 latency"
                  value={formatMs(kpis.worstLatencyP95)}
                  color={LEVEL_COLORS[latencyLevel("latency", kpis.worstLatencyP95)]}
                />
                <KpiTile
                  icon={Zap}
                  label="Worst p95 TTFT"
                  value={formatMs(kpis.worstTtftP95)}
                  color={LEVEL_COLORS[latencyLevel("ttft", kpis.worstTtftP95)]}
                />
                <KpiTile
                  icon={Gauge}
                  label="Saturation"
                  value={formatPct(kpis.saturationRate)}
                  color={LEVEL_COLORS[saturationLevel(kpis.saturationRate)]}
                  sub="rate-limited + overloaded"
                />
                <KpiTile
                  icon={GitBranch}
                  label="Fallback"
                  value={formatPct(kpis.fallbackRate)}
                  color={LEVEL_COLORS[fallbackLevel(kpis.fallbackRate)]}
                  sub="Fireworks → Together"
                />
                <KpiTile
                  icon={ThumbsUp}
                  label="Feedback"
                  value={`${formatCount(kpis.thumbsUp)} / ${formatCount(kpis.thumbsDown)}`}
                  sub="👍 / 👎 in range"
                />
              </XStack>
            ) : null}

            <XStack gap={16} flexWrap="wrap">
              <YStack flex={2} minWidth={380}>
                <Card title={range.unit === "day" ? "Request volume over time (turns per day)" : "Request volume over time (turns per hour)"} icon={Clock}>
                  <ModelHealthTimeseriesChart series={denseSeries} bucketTimeZone={bucketTimeZone} bucketUnit={range.unit} />
                </Card>
              </YStack>
              <YStack flex={1} minWidth={260}>
                {inflightCard}
              </YStack>
            </XStack>

            <Card title="LLM latency percentiles (p50→p99, ▬ = p95)" icon={Timer}>
              <PercentileBandChart models={models} metric="latency" />
            </Card>

            <Card title={range.unit === "day" ? "p95 latency by model & day" : "p95 latency by model & hour"} icon={Grid3x3}>
              <LatencyHeatmap series={denseSeries} metric="latency" bucketTimeZone={bucketTimeZone} bucketUnit={range.unit} />
            </Card>

            <Card title="Time to first token by model" icon={Zap}>
              <PercentileBandChart models={models} metric="ttft" />
            </Card>

            <Card title="Models — by request volume" icon={Activity}>
              <ModelTable models={models} />
            </Card>

            <Card title="Recent upstream errors" icon={AlertTriangle}>
              <UpstreamErrorsTable rows={upstreamErrors} loading={upstreamLoading} />
            </Card>

            <Card title="Quality & saturation signals" icon={Gauge}>
              <QualitySignalsTable models={models} />
            </Card>
          </YStack>
        </ScrollView>
      )}
    </YStack>
  )
}
