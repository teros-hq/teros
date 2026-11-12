/**
 * Shared ModelTable — extracted from ModelHealthWindowContent for code splitting.
 *
 * Renders the per-model reliability table (latency percentiles, error rate, success rate).
 * Used by both ModelHealthWindow and AgentUsageWindow (Agent Activity's "By model" tab).
 *
 * Extracted to a shared module so that AgentUsageWindow doesn't pull in
 * ModelHealthWindowContent eager when both are lazy-loaded.
 */

import { seriesColor } from "@teros/shared"
import { View } from "react-native"
import {
  type Column,
  DataTable,
  StatusDot as StatusIcon,
  metricTone,
} from "../../components/monitoring"
import { useColors } from "../../components/mca/primitives/useColors"
import { Dot } from "../../components/ui/ds/Badge"
import { T } from "../../components/ui/ds/Text"
import type { ModelHealthSummary } from "../../services/AdminApi"
import {
  errorRateLevel,
  formatCount,
  formatMs,
  formatPct,
  type HealthLevel,
  latencyLevel,
  useLevelColors,
  worseLevel,
} from "../ModelHealthWindow/format"

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

const LEVEL_STATUS: Record<HealthLevel, string> = { ok: "ok", warn: "warn", critical: "error" }

/** `${provider}::${modelId}` — the stable identity key that colors a model everywhere. */
const modelKey = (m: ModelHealthSummary) => `${m.actualProvider}::${m.modelId}`

const shortModelId = (id: string) => (id.includes("/") ? (id.split("/").pop() ?? id) : id)

/** Shared leading columns (status + model) so the two stacked tables align. */
export function modelLeadingColumns(): Column<ModelHealthSummary>[] {
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
          <Dot color={seriesColor(modelKey(m))} size={8} />
          <T step="sm" numberOfLines={1} style={{ flexShrink: 1 }}>
            {shortModelId(m.modelId)}
          </T>
          <T step="code" tone="text3" numberOfLines={1} style={{ flex: 1, fontSize: 10 }}>
            {m.actualProvider}
          </T>
        </View>
      ),
    },
  ]
}

/** Reusable per-model reliability table (also rendered in Agent Activity's "By model"). */
export function ModelTable({ models }: { models: ModelHealthSummary[] }) {
  const c = useColors()
  const level = useLevelColors()
  const columns: Column<ModelHealthSummary>[] = [
    ...modelLeadingColumns(),
    {
      key: "req",
      header: "Req",
      width: 92,
      align: "right",
      mono: true,
      color: () => c.text,
      render: (m) => formatCount(m.requestCount),
    },
    {
      key: "p50",
      header: "p50",
      width: 88,
      align: "right",
      mono: true,
      render: (m) => (m.latency.p50 == null ? "—" : formatMs(m.latency.p50)),
    },
    {
      key: "p95",
      header: "p95",
      width: 88,
      align: "right",
      mono: true,
      color: (m) => level[latencyLevel("latency", m.latency.p95, m.modelId)],
      render: (m) => (m.latency.p95 == null ? "—" : formatMs(m.latency.p95)),
    },
    {
      key: "p99",
      header: "p99",
      width: 88,
      align: "right",
      mono: true,
      color: () => c.text3,
      // When p99's rank lands in the unbounded overflow bucket the value is a
      // clamp (81920ms), not the real tail → prefix "≥" so it doesn't read as an
      // exact figure for reasoning models >82s (A3.1/TER-674).
      render: (m) =>
        m.latency.p99 == null ? "—" : `${m.latency.p99Capped ? "≥" : ""}${formatMs(m.latency.p99)}`,
    },
    {
      key: "ttft",
      header: "TTFT p95",
      width: 104,
      align: "right",
      mono: true,
      color: (m) => level[latencyLevel("ttft", m.ttft.p95, m.modelId)],
      render: (m) => (m.ttft.p95 == null ? "—" : formatMs(m.ttft.p95)),
    },
    {
      key: "err",
      header: "Err",
      width: 84,
      align: "right",
      mono: true,
      color: (m) => level[errorRateLevel(m.errorRate)],
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
      color: (m) => (m.successRate == null ? c.text3 : metricTone("success", m.successRate * 100)),
      render: (m) => formatPct(m.successRate),
    },
  ]
  return <DataTable columns={columns} rows={models} rowKey={modelKey} />
}
