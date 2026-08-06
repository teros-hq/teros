/**
 * Pure derivations for the billing audit window. Kept out of the *WindowContent
 * module so they are unit-testable: the render harness stubs every `*WindowContent`
 * import to a no-op, but plain helpers go through untouched (same pattern as
 * BillingRequestsWindow/payload.ts). The drift threshold is the high-risk piece —
 * it must flag exactly what the reconciliation cron alerts on — so it lives here
 * and is tested directly.
 */

/**
 * Same threshold as BillingReconciliationCron (FASE 2): a drift is significant
 * when it exceeds 0.5h in absolute terms OR 10% of max(expected, actual) — the
 * SAME denominator the cron uses (billing-reconciliation-cron.ts). Dividing by
 * `expected` alone diverged on over-consumption (actual > expected): the audit
 * flagged drift the cron would NOT alert on (review M3). The constants are
 * duplicated here (the frontend cannot import the backend cron); parity is pinned
 * by a test in audit.render.test.ts that reproduces the cron's exact formula.
 */
export const DRIFT_ABS_THRESHOLD_HOURS = 0.5
export const DRIFT_PCT_THRESHOLD = 0.1

export function isDriftSignificant(
  driftHours: number,
  expectedHours: number,
  actualHours: number,
): boolean {
  if (driftHours > DRIFT_ABS_THRESHOLD_HOURS) return true
  const denom = Math.max(expectedHours, actualHours)
  if (denom > 0 && driftHours / denom > DRIFT_PCT_THRESHOLD) return true
  return false
}

/**
 * Usage % of the effective limit, rounded to an integer. null when the plan is
 * unmetered (limit 0 / contact-sales) — there is no meaningful percentage then.
 */
export function usagePercent(used: number, limit: number): number | null {
  return limit > 0 ? Math.round((used / limit) * 100) : null
}

/**
 * Origin of a boost row. A self-serve purchase carries a purchaseId (its boost
 * _id IS the purchaseId); an admin grant carries an accessRequestId instead.
 */
export function boostOrigin(boost: { purchaseId: string | null }): "purchase" | "grant" {
  return boost.purchaseId ? "purchase" : "grant"
}
