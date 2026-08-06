/**
 * Billing canary SLO evaluation (FASE 5e): Prometheus parse + SLO grading.
 *
 * The daily canary scrapes /metrics and grades the last reconciliation run's
 * gauges. These asserts pin the EXACT breach payload and the boundary at each
 * threshold (a reading equal to the max is OK, strictly above is a breach).
 *
 * MUST BITE (confirmed red against mutated source):
 *   - `value > slo.max` → `>=`: a 0 reading on a max:0 SLO wrongly breaches,
 *   - dropping the required-metric presence check: a dead endpoint passes,
 *   - dropping `Number.isFinite`: a junk metric value is stored as NaN,
 *   - parsing the name past the brace: labeled metric name includes `{...}`.
 */

import { describe, expect, it } from "bun:test"
import {
  BILLING_SLOS,
  evaluateBillingSlos,
  parsePrometheusMetrics,
  REQUIRED_METRICS,
  type SloThreshold,
} from "../../src/services/billing-canary"

describe("parsePrometheusMetrics", () => {
  it("parses labeled and unlabeled lines, skipping comments/blanks", () => {
    const text = [
      "# HELP billing_reconciliation_max_drift_hours drift",
      "# TYPE billing_reconciliation_max_drift_hours gauge",
      'billing_reconciliation_max_drift_hours{instance="node-1"} 0.3',
      "",
      "billing_reconciliation_runs_total 42",
    ].join("\n")
    const m = parsePrometheusMetrics(text)
    expect(m.get("billing_reconciliation_max_drift_hours")).toBe(0.3)
    expect(m.get("billing_reconciliation_runs_total")).toBe(42)
    expect(m.size).toBe(2)
  })

  it("strips labels from the metric name", () => {
    const m = parsePrometheusMetrics('billing_charge_runs_total{instance="x",extra="y"} 7')
    expect(m.has("billing_charge_runs_total")).toBe(true)
    expect(m.get("billing_charge_runs_total")).toBe(7)
  })

  it("ignores non-finite values", () => {
    const m = parsePrometheusMetrics("foo NaN\nbar 1.5")
    expect(m.has("foo")).toBe(false)
    expect(m.get("bar")).toBe(1.5)
  })

  it("last value wins for a repeated name", () => {
    const m = parsePrometheusMetrics('x{instance="a"} 1\nx{instance="b"} 9')
    expect(m.get("x")).toBe(9)
  })
})

describe("evaluateBillingSlos", () => {
  function fullMetrics(over: Record<string, number> = {}): Map<string, number> {
    return new Map<string, number>([
      ["billing_reconciliation_runs_total", 10],
      ["agent_hours_tracker_runs_total", 20],
      ["billing_reconciliation_max_drift_hours", 0],
      ["billing_reconciliation_cutoff_stuck_subs", 0],
      ["billing_reconciliation_invoice_duplicates", 0],
      ["billing_reconciliation_stripe_drift", 0],
      ...Object.entries(over),
    ])
  }

  it("passes when every gauge is within bounds and required metrics present", () => {
    const result = evaluateBillingSlos(fullMetrics())
    expect(result).toEqual({ ok: true, breaches: [] })
  })

  it("treats a reading exactly at the max as OK (boundary)", () => {
    // max_drift SLO max is 0.5 — a 0.5 reading is fine, 0.51 is not.
    expect(evaluateBillingSlos(fullMetrics({ billing_reconciliation_max_drift_hours: 0.5 })).ok).toBe(
      true,
    )
    const breached = evaluateBillingSlos(
      fullMetrics({ billing_reconciliation_max_drift_hours: 0.51 }),
    )
    expect(breached.ok).toBe(false)
    expect(breached.breaches).toEqual([
      {
        metric: "billing_reconciliation_max_drift_hours",
        label: "agentHoursUsed drift (h)",
        value: 0.51,
        max: 0.5,
        severity: "error",
        reason: "exceeded",
      },
    ])
  })

  it("flags any positive reading on a zero-tolerance SLO", () => {
    const result = evaluateBillingSlos(fullMetrics({ billing_reconciliation_invoice_duplicates: 1 }))
    expect(result.ok).toBe(false)
    expect(result.breaches).toHaveLength(1)
    expect(result.breaches[0]).toMatchObject({
      metric: "billing_reconciliation_invoice_duplicates",
      value: 1,
      max: 0,
      reason: "exceeded",
    })
  })

  it("flags a missing required metric as a breach (endpoint dead/crons unwired)", () => {
    const m = fullMetrics()
    m.delete("billing_reconciliation_runs_total")
    const result = evaluateBillingSlos(m)
    expect(result.ok).toBe(false)
    expect(result.breaches).toEqual([
      {
        metric: "billing_reconciliation_runs_total",
        label: "required metric absent",
        value: null,
        max: null,
        severity: "error",
        reason: "missing",
      },
    ])
  })

  it("flags a missing SLO gauge as a breach", () => {
    const m = fullMetrics()
    m.delete("billing_reconciliation_stripe_drift")
    const result = evaluateBillingSlos(m)
    expect(result.breaches).toEqual([
      {
        metric: "billing_reconciliation_stripe_drift",
        label: "Teros↔Stripe paid-state drift",
        value: null,
        max: 0,
        severity: "error",
        reason: "missing",
      },
    ])
  })

  it("honors custom thresholds and required lists", () => {
    const slos: SloThreshold[] = [{ metric: "x", max: 5, label: "x", severity: "warning" }]
    expect(evaluateBillingSlos(new Map([["x", 5]]), slos, []).ok).toBe(true)
    const r = evaluateBillingSlos(new Map([["x", 6]]), slos, [])
    expect(r.breaches[0]).toMatchObject({ metric: "x", value: 6, severity: "warning" })
  })

  it("ships a non-empty default SLO + required set", () => {
    expect(BILLING_SLOS.length).toBeGreaterThan(0)
    expect(REQUIRED_METRICS.length).toBeGreaterThan(0)
  })
})
