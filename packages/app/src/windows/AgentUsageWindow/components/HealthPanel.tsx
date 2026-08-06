/**
 * Health panel — the instrumentation subsystem itself (buffer / reconcile /
 * rollup), so an admin can tell whether the numbers in the other tabs are being
 * captured reliably. Each group derives a level (ok/warn/critical) from its
 * error + lag counters; the worst level colors the group header.
 */

import { Text, XStack, YStack } from "tamagui"
import {
  type HealthLevel,
  levelColors,
  levelLabels,
  SectionCard,
  tokens,
} from "../../../components/monitoring"
import type { AgentUsageHealthResponse } from "../../../services/AdminApi"
import { relativeTimeFromMs } from "../formatters"
import { PanelNote } from "./panelBits"

function worse(a: HealthLevel, b: HealthLevel): HealthLevel {
  const rank: Record<HealthLevel, number> = { ok: 0, warn: 1, critical: 2 }
  return rank[a] >= rank[b] ? a : b
}

type Row = { label: string; value: string; level?: HealthLevel }

function bufferGroup(b: AgentUsageHealthResponse["buffer"]): { level: HealthLevel; rows: Row[] } {
  let level: HealthLevel = "ok"
  if (b.events_dropped > 0 || b.flush_errors > 0) level = "critical"
  else if (b.events_retried > 0 || b.queue_depth > b.queue_depth_high_water * 0.8) level = worse(level, "warn")
  return {
    level,
    rows: [
      { label: "Enqueued", value: b.events_enqueued.toLocaleString() },
      { label: "Flushed", value: b.events_flushed.toLocaleString() },
      { label: "Dropped", value: b.events_dropped.toLocaleString(), level: b.events_dropped > 0 ? "critical" : "ok" },
      { label: "Retried", value: b.events_retried.toLocaleString(), level: b.events_retried > 0 ? "warn" : "ok" },
      { label: "Flush errors", value: b.flush_errors.toLocaleString(), level: b.flush_errors > 0 ? "critical" : "ok" },
      { label: "Queue depth", value: `${b.queue_depth} / ${b.queue_depth_high_water} hw` },
      { label: "Flush p95", value: `${b.flush_latency_ms_p95} ms` },
    ],
  }
}

function reconcileGroup(r: AgentUsageHealthResponse["reconcile"]): { level: HealthLevel; rows: Row[] } {
  const level: HealthLevel = r.reconcile_errors > 0 ? "critical" : "ok"
  return {
    level,
    rows: [
      { label: "Sessions closed", value: r.reconcile_sessions_closed.toLocaleString() },
      { label: "Tools closed", value: r.reconcile_tools_closed.toLocaleString() },
      { label: "Errors", value: r.reconcile_errors.toLocaleString(), level: r.reconcile_errors > 0 ? "critical" : "ok" },
      { label: "Last run", value: r.reconcile_last_run_at ? relativeTimeFromMs(r.reconcile_last_run_at) : "never" },
    ],
  }
}

function rollupGroup(r: AgentUsageHealthResponse["rollup"]): { level: HealthLevel; rows: Row[] } {
  let level: HealthLevel = "ok"
  if (r.rollup_errors > 0) level = "critical"
  else if (r.rollup_lag_hours > 2) level = "warn"
  return {
    level,
    rows: [
      { label: "Docs written", value: r.rollup_docs_written.toLocaleString() },
      { label: "Errors", value: r.rollup_errors.toLocaleString(), level: r.rollup_errors > 0 ? "critical" : "ok" },
      { label: "Lag", value: `${r.rollup_lag_hours.toFixed(1)} h`, level: r.rollup_lag_hours > 2 ? "warn" : "ok" },
      { label: "Duration", value: `${r.rollup_job_duration_ms} ms` },
      { label: "Last run", value: r.rollup_last_run_at ? relativeTimeFromMs(r.rollup_last_run_at) : "never" },
    ],
  }
}

function Group({ title, level, rows }: { title: string; level: HealthLevel; rows: Row[] }) {
  return (
    <SectionCard
      title={title}
      right={
        <XStack ai="center" gap={6}>
          <YStack width={9} height={9} borderRadius={9999} backgroundColor={levelColors[level]} />
          <Text fontSize={12} fontWeight="600" color={levelColors[level]}>
            {levelLabels[level]}
          </Text>
        </XStack>
      }
    >
      <YStack gap={6}>
        {rows.map((r) => (
          <XStack key={r.label} jc="space-between" ai="center" gap={12}>
            <Text fontSize={13} color={tokens.textSecondary}>
              {r.label}
            </Text>
            <Text fontSize={13} fontFamily="$mono" color={r.level && r.level !== "ok" ? levelColors[r.level] : tokens.text}>
              {r.value}
            </Text>
          </XStack>
        ))}
      </YStack>
    </SectionCard>
  )
}

export function HealthPanel({ health }: { health: AgentUsageHealthResponse | null }) {
  if (!health) {
    return <PanelNote>Instrumentation health is unavailable.</PanelNote>
  }
  const buffer = bufferGroup(health.buffer)
  const reconcile = reconcileGroup(health.reconcile)
  const rollup = rollupGroup(health.rollup)
  return (
    <>
      <Group title="Event buffer" level={buffer.level} rows={buffer.rows} />
      <Group title="Reconcile" level={reconcile.level} rows={reconcile.rows} />
      <Group title="Rollup" level={rollup.level} rows={rollup.rows} />
    </>
  )
}
