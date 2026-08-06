/**
 * Billing canary (FASE 5e) — daily synthetic SLO check.
 *
 * Scrapes /health + /metrics on the running backend, grades the billing SLOs
 * (packages/backend/src/services/billing-canary.ts), prints a report, raises a
 * Sentry alert on breach, and exits non-zero so an external scheduler (cron/CI)
 * flags it. Designed to run once a day from system cron or a scheduled CI job.
 *
 * /metrics is IP-gated (FASE 5a) — point this at the INTERNAL port from the
 * host (127.0.0.1:10001), not the public proxy, so the source IP is allowlisted.
 *
 * Exit codes: 0 = all SLOs ok · 1 = SLO breach · 2 = endpoint down · 3 = error.
 *
 * Usage:
 *   BILLING_CANARY_URL=http://127.0.0.1:10001 \
 *     npx tsx --tsconfig packages/backend/tsconfig.json scripts/billing-canary.ts
 */

import { config as dotenvConfig } from "dotenv"
import { captureMessage, flush, initSentry } from "../packages/backend/src/lib/sentry"
import {
  BILLING_SLOS,
  evaluateBillingSlos,
  parsePrometheusMetrics,
} from "../packages/backend/src/services/billing-canary"

dotenvConfig()

const BASE_URL = process.env.BILLING_CANARY_URL || "http://127.0.0.1:10001"

async function main(): Promise<number> {
  initSentry()

  // 1. Liveness — /health must be ok.
  try {
    const res = await fetch(`${BASE_URL}/health`)
    const body = (await res.json().catch(() => ({}))) as { status?: string }
    if (!res.ok || body.status !== "ok") {
      console.error(`[canary] /health not ok: ${res.status} ${JSON.stringify(body)}`)
      captureMessage("billing/canary_health_down", "error", { status: res.status, body })
      return 2
    }
  } catch (err) {
    console.error(`[canary] /health unreachable: ${(err as Error).message}`)
    captureMessage("billing/canary_health_down", "error", { error: (err as Error).message })
    return 2
  }

  // 2. SLOs — scrape /metrics and grade.
  let metricsText: string
  try {
    const res = await fetch(`${BASE_URL}/metrics`)
    if (!res.ok) {
      console.error(`[canary] /metrics returned ${res.status}`)
      captureMessage("billing/canary_metrics_unreachable", "error", { status: res.status })
      return 2
    }
    metricsText = await res.text()
  } catch (err) {
    console.error(`[canary] /metrics unreachable: ${(err as Error).message}`)
    captureMessage("billing/canary_metrics_unreachable", "error", { error: (err as Error).message })
    return 2
  }

  const metrics = parsePrometheusMetrics(metricsText)
  const result = evaluateBillingSlos(metrics)

  if (result.ok) {
    console.log(
      `[canary] OK — ${BILLING_SLOS.length} SLOs within bounds (${metrics.size} metrics scraped)`,
    )
    return 0
  }

  console.error(`[canary] ${result.breaches.length} SLO breach(es):`)
  for (const b of result.breaches) {
    const detail = b.reason === "missing" ? "MISSING" : `${b.value} > ${b.max}`
    console.error(`  - [${b.severity}] ${b.metric} (${b.label}): ${detail}`)
  }
  captureMessage("billing/canary_slo_breach", "error", { breaches: result.breaches })
  return 1
}

main()
  .then(async (code) => {
    await flush(3000)
    process.exit(code)
  })
  .catch(async (err) => {
    console.error("[canary] unexpected error:", err)
    captureMessage("billing/canary_error", "error", { error: (err as Error)?.message })
    await flush(3000)
    process.exit(3)
  })
