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
 * Drawn as the OS prototype's page: `Page` on the sheet → MonitoringHeader
 * (eyebrow + serif title + view chips + period controls) → Stat tiles → chart
 * and table cards. Accessibility: thresholds are icon + text + colour (never
 * colour alone). Loading/empty/error are handled per-window (not a blanked
 * screen).
 */

import { useMemo, useState } from "react"
import { View, useWindowDimensions } from "react-native"
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
  LEVEL_LABELS,
  LEVEL_TINT,
  latencyLevel,
  saturationLevel,
  toolErrorLevel,
  truncationLevel,
  useLevelColors,
  worseLevel,
} from "./format"
import { useInflightGauge } from "./hooks/useInflightGauge"
import { useModelHealthData } from "./hooks/useModelHealthData"
import { useUpstreamErrors } from "./hooks/useUpstreamErrors"
import {
  type BucketUnit,
  DataTable,
  type Column,
  KpiStrip,
  KpiTile,
  MonitoringHeader,
  type MonitoringTarget,
  SectionCard,
  fillSeriesBuckets,
  metricTone,
  unitForPeriodMs,
  useAutoRefresh,
} from "../../components/monitoring"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { Badge } from "../../components/ui/ds/Badge"
import { ChipBtn, IconBtn } from "../../components/ui/ds/Buttons"
import { Ph } from "../../components/ui/ds/Icon"
import { EmptyState, Page } from "../../components/ui/ds/Page"
import { T } from "../../components/ui/ds/Text"
import { ModelTable, modelLeadingColumns } from "../shared/ModelTable"

type Period = "1h" | "24h" | "7d" | "30d"
const PERIODS: { value: Period; label: string; ms: number }[] = [
  { value: "1h", label: "1 h", ms: 3_600_000 },
  { value: "24h", label: "24 h", ms: 86_400_000 },
  { value: "7d", label: "7 d", ms: 7 * 86_400_000 },
  { value: "30d", label: "30 d", ms: 30 * 86_400_000 },
]

/** Worst health level across latency p95, ttft p95 and error-rate for one model. */
function modelLevel(m: ModelHealthSummary): HealthLevel {
  return worseLevel(
    worseLevel(
      latencyLevel("latency", m.latency.p95, m.modelId),
      latencyLevel("ttft", m.ttft.p95, m.modelId),
    ),
    errorRateLevel(m.errorRate),
  )
}

/** `${provider}::${modelId}` — the stable identity key that colors a model everywhere. */
const modelKey = (m: ModelHealthSummary) => `${m.actualProvider}::${m.modelId}`

/**
 * Sub-reason → dot colour for the upstream-errors feed (TER-700). Amber = capacity
 * (self-heals), red = billing/auth (intervention), muted = model config, violet =
 * account rate-limit. Never colour alone — the label sits next to the dot.
 */
function subReasonColor(sub: string | undefined, c: { accent: string; text3: string }): string {
  switch (sub) {
    case "provider_capacity":
    case "provider_overloaded":
      return semantic.amber
    case "account_rate_limit":
    case "token_rate_limit":
      return c.accent
    case "provider_billing":
    case "provider_server_error":
    case "auth":
      return semantic.red
    default:
      return c.text3
  }
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
      <T step="sm" tone="text3">
        Loading…
      </T>
    )
  }
  if (rows.length === 0) {
    return (
      <T step="sm" tone="text3">
        No upstream errors in this window — a healthy signal.
      </T>
    )
  }
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingBottom: 8,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        }}
      >
        <T step="codenote" tone="text3" style={{ width: 56 }}>
          When
        </T>
        <T step="codenote" tone="text3" style={{ flex: 1.4 }}>
          Provider · model
        </T>
        <T step="codenote" tone="text3" style={{ flex: 1.2 }}>
          Sub-reason
        </T>
        <T step="codenote" tone="text3" style={{ flex: 2 }}>
          Message
        </T>
      </View>
      {rows.map((r, i) => (
        <View
          key={`${r.time ?? ""}-${i}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 9,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <T step="code" tone="text2" style={{ width: 56 }}>
            {fmtErrTime(r.time)}
          </T>
          <T step="code" tone="text2" numberOfLines={1} style={{ flex: 1.4 }}>
            {r.provider ?? "—"} · {r.model ?? "—"}
          </T>
          <View style={{ flex: 1.2, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: subReasonColor(r.errorSubReason, c),
              }}
            />
            <T step="12" tone="text2" numberOfLines={1} style={{ flexShrink: 1 }}>
              {r.errorSubReason ?? r.errorKind ?? "—"}
            </T>
          </View>
          <T step="code" tone="text2" numberOfLines={1} style={{ flex: 2 }}>
            {r.upstreamMessage ?? "—"}
          </T>
        </View>
      ))}
    </View>
  )
}

/**
 * Quality + saturation signals per model (§3.1 + §2.1, R7.3): the proxies that
 * don't fit the latency-centric main table. `—` when a model carries no tool
 * calls (toolErrorRate has no denominator). Thumbs are query-time feedback.
 */
function QualitySignalsTable({ models }: { models: ModelHealthSummary[] }) {
  const c = useColors()
  const level = useLevelColors()
  const columns: Column<ModelHealthSummary>[] = [
    ...modelLeadingColumns(),
    {
      key: "sat",
      header: "Saturation",
      width: 150,
      align: "left",
      render: (m) => {
        const lvl = saturationLevel(m.saturationRate ?? 0)
        const fill = lvl === "critical" ? semantic.red : lvl === "warn" ? semantic.amber : c.accent
        return (
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}
          >
            <View
              style={{
                flex: 1,
                maxWidth: 70,
                height: 6,
                borderRadius: 3,
                backgroundColor: c.wash,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  height: "100%",
                  width: `${Math.min(100, (m.saturationRate ?? 0) * 100)}%`,
                  backgroundColor: fill,
                  borderRadius: 3,
                }}
              />
            </View>
            <T step="code" color={lvl === "ok" ? c.text2 : level[lvl]}>
              {formatPct(m.saturationRate ?? 0)}
            </T>
          </View>
        )
      },
    },
    {
      key: "fallback",
      header: "Fallback",
      width: 100,
      align: "right",
      mono: true,
      color: (m) => level[fallbackLevel(m.fallbackRate ?? 0)],
      render: (m) => formatPct(m.fallbackRate ?? 0),
    },
    {
      key: "truncation",
      header: "Truncation",
      width: 108,
      align: "right",
      mono: true,
      color: (m) => (m.truncationRate == null ? c.text3 : level[truncationLevel(m.truncationRate)]),
      render: (m) => formatPct(m.truncationRate),
    },
    {
      key: "toolerr",
      header: "Tool err",
      width: 96,
      align: "right",
      mono: true,
      color: (m) => level[toolErrorLevel(m.toolErrorRate ?? 0)],
      render: (m) => (m.toolCallCount ? formatPct(m.toolErrorRate ?? 0) : "—"),
    },
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
            <T step="code" tone="text3" style={{ textAlign: "right", width: "100%" }}>
              —
            </T>
          )
        const pct = Math.round((up / tot) * 100)
        return (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              justifyContent: "flex-end",
              flex: 1,
            }}
          >
            <Ph name="thumbs-up" size={13} color={metricTone("fb", pct)} />
            <T step="code" color={metricTone("fb", pct)}>
              {pct}%
            </T>
            <T step="code" tone="text3" style={{ fontSize: 10 }}>
              {formatCount(tot)}
            </T>
          </View>
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
  const label = incidents
    .map(([name, ind]) => `${name}: ${UPSTREAM_INDICATOR_META[ind].label}`)
    .join(" · ")
  return (
    <View
      {...({
        "aria-label": `Upstream incident: ${incidents
          .map(([name, ind]) => `${name} ${UPSTREAM_INDICATOR_META[ind].label}`)
          .join(", ")}`,
      } as any)}
    >
      <Badge tone={LEVEL_TINT[worst]} icon="warning" pill>
        {label}
      </Badge>
    </View>
  )
}

export type ModelHealthWindowProps = {
  /** Initial period propagated from a Hub drill so the view keeps it (A5.4/TER-672). */
  initialPeriod?: Period
}

export function ModelHealthWindowContent({ initialPeriod }: ModelHealthWindowProps) {
  const c = useColors()
  const level = useLevelColors()
  const { width: winW } = useWindowDimensions()
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

  const {
    models,
    series,
    bucketTimeZone,
    periodMinutes,
    upstreamStatus,
    loading,
    refreshing,
    error,
  } = useModelHealthData({
    client,
    range,
    groupBy: range.unit,
  })
  const inflightData = useInflightGauge(client)
  const { rows: upstreamErrors, loading: upstreamLoading } = useUpstreamErrors({ client, range })

  // Uniform time axis (N6): fill the buckets the range expects, so a quiet
  // hour/day is a visible zero instead of an invisible gap.
  const denseSeries = useMemo(
    () =>
      fillSeriesBuckets(series, range.from, range.to, range.unit, (iso) => ({
        hourBucket: iso,
        models: [],
      })),
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

  /** A KPI figure's colour: muted-neutral when ok, the tint when it crosses a threshold. */
  const tone = (lvl: HealthLevel) => (lvl === "ok" ? c.text : level[lvl])

  // In-flight is a live, range-independent signal — render it even in the empty
  // state, so "no rollups yet, but 2 streams running now" is still visible.
  const inflightCard = (
    <SectionCard title="In-flight LLM streams (live)">
      <InflightGauge
        inflight={inflightData.inflight}
        total={inflightData.total}
        capturedAt={inflightData.capturedAt}
        error={inflightData.error}
      />
    </SectionCard>
  )

  const header = (
    <MonitoringHeader
      title="Model Health"
      activeView="models"
      statusLevel={
        kpis ? (kpis.global === "ok" ? "ok" : kpis.global === "warn" ? "degraded" : "error") : "ok"
      }
      statusText={kpis ? LEVEL_LABELS[kpis.global] : undefined}
      onNavigate={nav}
      controls={
        <>
          {PERIODS.map((p) => (
            <ChipBtn key={p.value} mono on={period === p.value} onPress={() => setPeriod(p.value)}>
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
  )

  if (loading) {
    return (
      <Page>
        {header}
        <FullscreenLoader />
      </Page>
    )
  }

  if (error) {
    const forbidden = error === "Admin privileges required"
    return (
      <Page>
        {header}
        <EmptyState
          icon={forbidden ? "shield-check" : "warning"}
          title={error}
          text={
            forbidden
              ? "This window is restricted to system admins (role ∈ admin | super)."
              : undefined
          }
        />
      </Page>
    )
  }

  const stackCharts = winW < 980

  return (
    <Page>
      {header}
      <View style={{ gap: 16 }}>
        {upstreamStatus ? <UpstreamBadge status={upstreamStatus} /> : null}

        {models.length === 0 ? (
          <>
            <EmptyState
              icon="pulse"
              title="No model activity"
              text="No model activity in the selected period."
            />
            {inflightCard}
          </>
        ) : (
          <>
            {/* KPI strip */}
            {kpis ? (
              <KpiStrip>
                <KpiTile
                  icon="pulse"
                  label="Requests"
                  value={formatCount(kpis.totalReq)}
                  sub={`${kpis.modelCount} models · ${kpis.upstreams} upstreams`}
                />
                <KpiTile
                  icon="trend-up"
                  label="Throughput"
                  value={formatRate(periodMinutes > 0 ? kpis.totalReq / periodMinutes : 0)}
                  sub="turns per minute"
                />
                <KpiTile
                  icon="warning"
                  label="Error rate"
                  value={formatPct(kpis.errorRate)}
                  valueColor={tone(errorRateLevel(kpis.errorRate))}
                />
                <KpiTile
                  icon="timer"
                  label="Worst p95 latency"
                  value={formatMs(kpis.worstLatencyP95)}
                  valueColor={tone(latencyLevel("latency", kpis.worstLatencyP95))}
                />
                <KpiTile
                  icon="lightning"
                  label="Worst p95 TTFT"
                  value={formatMs(kpis.worstTtftP95)}
                  valueColor={tone(latencyLevel("ttft", kpis.worstTtftP95))}
                />
                <KpiTile
                  icon="gauge"
                  label="Saturation"
                  value={formatPct(kpis.saturationRate)}
                  valueColor={tone(saturationLevel(kpis.saturationRate))}
                  sub="rate-limited + overloaded"
                />
                <KpiTile
                  icon="git-branch"
                  label="Fallback"
                  value={formatPct(kpis.fallbackRate)}
                  valueColor={tone(fallbackLevel(kpis.fallbackRate))}
                  sub="Fireworks → Together"
                />
                <KpiTile
                  icon="thumbs-up"
                  label="Feedback"
                  value={`${formatCount(kpis.thumbsUp)} / ${formatCount(kpis.thumbsDown)}`}
                  sub="👍 / 👎 in range"
                />
              </KpiStrip>
            ) : null}

            <View
              style={{
                flexDirection: stackCharts ? "column" : "row",
                gap: 16,
                alignItems: "stretch",
              }}
            >
              <View style={{ flex: stackCharts ? undefined : 2, minWidth: 0 }}>
                <SectionCard
                  title={
                    range.unit === "day"
                      ? "Request volume over time (turns per day)"
                      : "Request volume over time (turns per hour)"
                  }
                >
                  <ModelHealthTimeseriesChart
                    series={denseSeries}
                    bucketTimeZone={bucketTimeZone}
                    bucketUnit={range.unit}
                  />
                </SectionCard>
              </View>
              <View style={{ flex: stackCharts ? undefined : 1, minWidth: 0 }}>{inflightCard}</View>
            </View>

            <SectionCard title="LLM latency percentiles (p50→p99, ▬ = p95)">
              <PercentileBandChart models={models} metric="latency" />
            </SectionCard>

            <SectionCard
              title={
                range.unit === "day" ? "p95 latency by model & day" : "p95 latency by model & hour"
              }
            >
              <LatencyHeatmap
                series={denseSeries}
                metric="latency"
                bucketTimeZone={bucketTimeZone}
                bucketUnit={range.unit}
              />
            </SectionCard>

            <SectionCard title="Time to first token by model">
              <PercentileBandChart models={models} metric="ttft" />
            </SectionCard>

            <SectionCard title="Models — by request volume">
              <ModelTable models={models} />
            </SectionCard>

            <SectionCard title="Recent upstream errors">
              <UpstreamErrorsTable rows={upstreamErrors} loading={upstreamLoading} />
            </SectionCard>

            <SectionCard title="Quality & saturation signals">
              <QualitySignalsTable models={models} />
            </SectionCard>
          </>
        )}
      </View>
    </Page>
  )
}
