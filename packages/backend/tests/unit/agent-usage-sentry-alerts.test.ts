/**
 * Model-health alarm thresholds (TER-616/§2.4, R5).
 *
 * `evaluateModelHealthAlerts` is the pure decision layer — it turns a set of
 * per-upstream summaries + thresholds into the list of alarms to raise, with no
 * Sentry or DB side effects, so every threshold is unit + mutation testable.
 */

import { describe, expect, it } from "bun:test"
import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateModelHealthAlerts,
  isReconciledSpike,
} from "../../src/services/agent-usage-sentry-alerts"
import type { ModelHealthSummary } from "../../src/services/model-health-aggregator"

function summary(over: Partial<ModelHealthSummary> = {}): ModelHealthSummary {
  return {
    actualProvider: "fireworks",
    modelId: "kimi",
    requestCount: 100,
    latency: { count: 100, p50: 800, p95: 1500, p99: 2000 },
    ttft: { count: 100, p50: 200, p95: 400, p99: 600 },
    statusCounts: {},
    errorCounts: {},
    finishReasons: {},
    errorRate: 0,
    successRate: 1,
    timeoutRate: 0,
    abortRate: 0,
    saturationRate: 0,
    fallbackRate: 0,
    emptyRate: 0,
    truncationRate: 0,
    toolErrorRate: 0,
    toolCallCount: 0,
    ...over,
  }
}

describe("evaluateModelHealthAlerts (TER-616/R5)", () => {
  const T = DEFAULT_ALERT_THRESHOLDS

  it("is silent for a healthy model with enough volume", () => {
    expect(evaluateModelHealthAlerts([summary()], T)).toEqual([])
  })

  it("skips a model below the minimum request volume even when badly degraded", () => {
    // Mutation: dropping the minRequests guard makes this return alerts → red.
    expect(evaluateModelHealthAlerts([summary({ requestCount: 5, errorRate: 0.9 })], T)).toEqual([])
  })

  it("fires error_rate at error level above the threshold, keyed by upstream::model", () => {
    const alerts = evaluateModelHealthAlerts([summary({ errorRate: 0.5 })], T)
    const e = alerts.find((a) => a.alertType === "error_rate")
    expect(e).toBeDefined()
    expect(e!.level).toBe("error")
    expect(e!.key).toBe("fireworks::kimi")
  })

  it("fires spend_gate on ANY 402 occurrence (never noise)", () => {
    const alerts = evaluateModelHealthAlerts([summary({ errorCounts: { spend_gate: 1 } })], T)
    const a = alerts.find((x) => x.alertType === "spend_gate")
    expect(a).toBeDefined()
    expect(a!.level).toBe("error")
  })

  it("fires ttft_p95 / rate_limited / fallback_rate above the shared critical bar", () => {
    const alerts = evaluateModelHealthAlerts(
      [
        summary({
          // kimi is a reasoning model → its TTFT critical is 12s; 13s clears it.
          ttft: { count: 100, p50: 1000, p95: 13000, p99: 15000 },
          saturationRate: 0.5,
          fallbackRate: 0.3,
        }),
      ],
      T,
    )
    const types = alerts.map((a) => a.alertType)
    expect(types).toContain("ttft_p95")
    expect(types).toContain("rate_limited")
    expect(types).toContain("fallback_rate")
  })

  it("does NOT page a reasoning model for latency that is normal for its class (TER-670)", () => {
    // kimi (reasoning) at 9s TTFT: red under the old fixed 5s bar (false positive
    // that kept the pager ringing), fine under the reasoning band. Mutation: a
    // fixed bar / dropping the class scope makes this fire → red.
    const alerts = evaluateModelHealthAlerts(
      [summary({ modelId: "kimi", ttft: { count: 100, p50: 4000, p95: 9000, p99: 11000 } })],
      T,
    )
    expect(alerts.map((a) => a.alertType)).not.toContain("ttft_p95")
  })

  it("pages a standard model at the standard latency bar (5s TTFT)", () => {
    const alerts = evaluateModelHealthAlerts(
      [summary({ actualProvider: "openai", modelId: "gpt-4o", ttft: { count: 100, p50: 2000, p95: 6000, p99: 7000 } })],
      T,
    )
    expect(alerts.map((a) => a.alertType)).toContain("ttft_p95")
  })

  it("does NOT fire ttft_p95 when p95 is null (no TTFT samples)", () => {
    const alerts = evaluateModelHealthAlerts(
      [summary({ ttft: { count: 0, p50: null, p95: null, p99: null } })],
      T,
    )
    expect(alerts.map((a) => a.alertType)).not.toContain("ttft_p95")
  })
})

describe("isReconciledSpike (TER-650: phantom-session detection)", () => {
  const T = DEFAULT_ALERT_THRESHOLDS.reconciledSessionsSpikeThreshold

  it("does not fire on the first observation, even for a huge count (startup backlog)", () => {
    // Mutation: dropping the `lastClosed <= 0` guard makes this true → red.
    expect(isReconciledSpike(0, 500, T)).toBe(false)
  })

  it("fires when the per-window delta reaches the threshold", () => {
    expect(isReconciledSpike(5, 5 + T, T)).toBe(true)
  })

  it("stays silent one below the threshold", () => {
    expect(isReconciledSpike(5, 5 + T - 1, T)).toBe(false)
  })

  it("stays silent between reconciler ticks (no change)", () => {
    expect(isReconciledSpike(100, 100, T)).toBe(false)
  })
})
