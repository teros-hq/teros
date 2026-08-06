/**
 * Billing canary (FASE 5e) — pure SLO evaluation over a /metrics snapshot.
 *
 * The daily synthetic canary (scripts/billing-canary.ts) scrapes /metrics and
 * feeds the parsed gauges here; we grade them against the billing SLOs and
 * report breaches. Kept pure (no fetch / no Sentry) so it is unit-testable —
 * the script is the thin I/O shell.
 *
 * We grade the point-in-time GAUGES from the last reconciliation run (drift,
 * stuck cutoffs, duplicate invoices, Teros↔Stripe divergence). Those directly
 * reflect current correctness; cumulative counters need a stateful baseline a
 * stateless daily probe can't provide, so they're only checked for presence.
 */

export interface SloThreshold {
  /** Prometheus metric name (base, without labels). */
  metric: string
  /** Max acceptable value; a reading strictly greater than this is a breach. */
  max: number
  /** Human label for the SLO. */
  label: string
  severity: "warning" | "error"
}

/** Billing SLOs graded from the last reconciliation run. */
export const BILLING_SLOS: SloThreshold[] = [
  {
    metric: "billing_reconciliation_max_drift_hours",
    max: 0.5,
    label: "agentHoursUsed drift (h)",
    severity: "error",
  },
  {
    metric: "billing_reconciliation_cutoff_stuck_subs",
    max: 0,
    label: "tracker cutoff stuck >24h",
    severity: "error",
  },
  {
    metric: "billing_reconciliation_invoice_duplicates",
    max: 0,
    label: "duplicate invoice groups",
    severity: "error",
  },
  {
    metric: "billing_reconciliation_stripe_drift",
    max: 0,
    label: "Teros↔Stripe paid-state drift",
    severity: "error",
  },
]

/** Metrics that must be PRESENT (endpoint reachable + crons wired). */
export const REQUIRED_METRICS = [
  "billing_reconciliation_runs_total",
  "agent_hours_tracker_runs_total",
]

export interface SloBreach {
  metric: string
  label: string
  /** The reading, or null when the metric was absent. */
  value: number | null
  /** The threshold, or null for a presence check. */
  max: number | null
  severity: "warning" | "error"
  reason: "exceeded" | "missing"
}

export interface CanaryResult {
  ok: boolean
  breaches: SloBreach[]
}

/**
 * Parse Prometheus text exposition into a name→value map. Labels are stripped
 * (the canary scrapes a single instance); the last value for a name wins.
 * Comment (#) and blank lines are skipped; non-finite values are ignored.
 */
export function parsePrometheusMetrics(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const braceIdx = line.indexOf("{")
    const valueStart = braceIdx === -1 ? line.indexOf(" ") : line.indexOf(" ", line.indexOf("}"))
    if (valueStart === -1) continue
    const name = (braceIdx === -1 ? line.slice(0, valueStart) : line.slice(0, braceIdx)).trim()
    const value = Number(line.slice(valueStart + 1).trim())
    if (name && Number.isFinite(value)) out.set(name, value)
  }
  return out
}

/**
 * Grade the parsed metrics against the SLOs + required-presence checks. A
 * reading strictly above its `max` is a breach; a missing required or SLO
 * metric is a breach (the canary couldn't confirm the system is healthy).
 */
export function evaluateBillingSlos(
  metrics: Map<string, number>,
  slos: SloThreshold[] = BILLING_SLOS,
  required: string[] = REQUIRED_METRICS,
): CanaryResult {
  const breaches: SloBreach[] = []
  for (const name of required) {
    if (!metrics.has(name)) {
      breaches.push({
        metric: name,
        label: "required metric absent",
        value: null,
        max: null,
        severity: "error",
        reason: "missing",
      })
    }
  }
  for (const slo of slos) {
    const value = metrics.get(slo.metric)
    if (value === undefined) {
      breaches.push({
        metric: slo.metric,
        label: slo.label,
        value: null,
        max: slo.max,
        severity: slo.severity,
        reason: "missing",
      })
      continue
    }
    if (value > slo.max) {
      breaches.push({
        metric: slo.metric,
        label: slo.label,
        value,
        max: slo.max,
        severity: slo.severity,
        reason: "exceeded",
      })
    }
  }
  return { ok: breaches.length === 0, breaches }
}
