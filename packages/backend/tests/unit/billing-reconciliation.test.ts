/**
 * Tests for BillingReconciliationCron (FASE 2c/2d).
 *
 * The cron re-derives each active sub's current-period hours straight from the
 * rollups and compares against agentHoursUsed, flagging drift; it also detects a
 * stuck tracker cutoff and duplicate invoices. We assert on the cron's return
 * values + metrics (the observable behavior) rather than spying on captureMessage
 * — the Sentry emit is co-located with each increment, and mocking lib/sentry
 * would leak globally across the bun test process.
 *
 * These tests MUST BITE:
 *   - Loosening the drift comparison turns the drift assertions red.
 *   - Dropping the period lower-bound (re-summing all history) would inflate
 *     `expected` and flag the clean case → "no drift" red.
 *   - Removing the stuck/duplicate checks turns those counts to 0 → red.
 */

import { describe, expect, it } from 'bun:test'
import {
  BillingReconciliationCron,
  DRIFT_ABS_HOURS,
} from '../../src/services/billing-reconciliation-cron'

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

const HOUR_MS = 3_600_000

function hb(h: number): Date {
  return new Date(Date.UTC(2026, 0, 1, h))
}

interface Sub {
  _id: string
  userId: string
  planId: string
  status: string
  agentHoursUsed: number
  currentPeriodStart: Date
  periodStartBucket?: Date
  lastBilledHourBucket?: Date
}

interface Rollup {
  groupKey: { userId: string }
  hourBucket: Date
  userActiveMs: number
}

function roll(userId: string, h: number, hours = 1): Rollup {
  return { groupKey: { userId }, hourBucket: hb(h), userActiveMs: hours * HOUR_MS }
}

function makeCursor<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next() {
          if (i < items.length) return Promise.resolve({ value: items[i++], done: false })
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
    async close() {},
  }
}

function makeDb(subs: Sub[], rollups: Rollup[], invoices: any[] = []) {
  return {
    collection(name: string) {
      if (name === 'billing_subscriptions') {
        return {
          find(filter: any) {
            return makeCursor(subs.filter((s) => s.status === filter.status))
          },
        }
      }
      if (name === 'agent_usage_rollups_user_hourly') {
        return {
          aggregate(pipeline: any[]) {
            const match = pipeline[0].$match
            const uid: string = match['groupKey.userId']
            const group = pipeline[1].$group
            const gt: Date = match.hourBucket.$gt
            const lte: Date | undefined = match.hourBucket.$lte
            const rows = rollups.filter(
              (r) =>
                r.groupKey.userId === uid &&
                r.hourBucket > gt &&
                (lte === undefined || r.hourBucket <= lte),
            )
            return {
              async toArray() {
                if ('totalMs' in group) {
                  return [{ totalMs: rows.reduce((a, r) => a + r.userActiveMs, 0) }]
                }
                // oldest ($min hourBucket)
                if (rows.length === 0) return [{ oldest: null }]
                const oldest = rows.reduce(
                  (m, r) => (r.hourBucket < m ? r.hourBucket : m),
                  rows[0].hourBucket,
                )
                return [{ oldest }]
              },
            }
          },
        }
      }
      if (name === 'billing_invoices') {
        return {
          aggregate(_pipeline: any[]) {
            return {
              async toArray() {
                const counts = new Map<string, number>()
                for (const i of invoices) {
                  const k = `${i.subscriptionId}|${+i.periodStart}|${+i.periodEnd}`
                  counts.set(k, (counts.get(k) ?? 0) + 1)
                }
                const groups = [...counts.values()].filter((c) => c > 1).length
                return groups > 0 ? [{ groups }] : []
              },
            }
          },
        }
      }
      return null as any
    },
  } as any
}

function sub(over: Partial<Sub> = {}): Sub {
  return {
    _id: 'sub_1',
    userId: 'A',
    planId: 'plan_pro',
    status: 'active',
    agentHoursUsed: 0,
    currentPeriodStart: hb(0),
    lastBilledHourBucket: hb(10),
    ...over,
  }
}

const NOW = hb(48) // reference "now" well after the buckets

describe('BillingReconciliationCron — drift detection (FASE 2c)', () => {
  it('reports zero drift when agentHoursUsed matches the rollups', async () => {
    // 10 buckets of 1h in (period start, cursor] → expected 10, actual 10.
    const rollups = Array.from({ length: 10 }, (_, i) => roll('A', i + 1))
    const cron = new BillingReconciliationCron(
      makeDb([sub({ agentHoursUsed: 10 })], rollups),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: NOW })

    expect(result.subsChecked).toBe(1)
    expect(result.driftIncidents).toBe(0)
    expect(result.maxDriftHours).toBe(0)
  })

  it('flags an absolute drift above 0.5h (the double-count signature)', async () => {
    // Rollups say 10h, but agentHoursUsed is 13h (tracker double-counted 3h).
    const rollups = Array.from({ length: 10 }, (_, i) => roll('A', i + 1))
    const cron = new BillingReconciliationCron(
      makeDb([sub({ agentHoursUsed: 13 })], rollups),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: NOW })

    expect(result.driftIncidents).toBe(1)
    expect(result.maxDriftHours).toBe(3)
    expect(result.maxDriftHours).toBeGreaterThan(DRIFT_ABS_HOURS)
  })

  it('flags a small relative drift (>10%) even under the 0.5h absolute floor', async () => {
    // expected 1h, actual 1.2h → drift 0.2h (< 0.5h) but 16.7% (> 10%).
    const rollups = [roll('A', 1)]
    const cron = new BillingReconciliationCron(
      makeDb([sub({ agentHoursUsed: 1.2 })], rollups),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: NOW })

    // BITE: requiring BOTH thresholds (instead of OR) would miss this.
    expect(result.driftIncidents).toBe(1)
  })

  it('only counts this period: rollups before currentPeriodStart do not inflate expected', async () => {
    // 5 old buckets (<= period start) + 4 in-period. Cursor at hb(10).
    // expected = in-period only (4h). actual 4 → no drift.
    const rollups = [
      roll('A', -3),
      roll('A', -2),
      roll('A', -1),
      roll('A', 0), // hb(0) == periodStart, excluded by $gt
      roll('A', 1),
      roll('A', 2),
      roll('A', 3),
      roll('A', 4),
    ]
    const cron = new BillingReconciliationCron(
      makeDb([sub({ agentHoursUsed: 4, currentPeriodStart: hb(0) })], rollups),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: NOW })

    // BITE: dropping the period lower-bound would sum the old buckets too →
    // expected 8 vs actual 4 → false drift.
    expect(result.driftIncidents).toBe(0)
  })

  it('does not flag spurious drift after a renewal: re-sums from periodStartBucket, not currentPeriodStart (TER-627)', async () => {
    // Renewed sub: the cursor (lastBilledHourBucket) is KEPT across the renewal, so
    // the tracker resumed counting from periodStartBucket hb(5) — BEFORE the new
    // currentPeriodStart hb(8). The previous period's tail hb(6) thus lands in
    // agentHoursUsed, and reconcile must re-sum from hb(5) too.
    const rollups = [roll('A', 6), roll('A', 9), roll('A', 11)] // (hb5, hb12] → 3h
    const cron = new BillingReconciliationCron(
      makeDb(
        [
          sub({
            agentHoursUsed: 3, // what the tracker summed from periodStartBucket
            periodStartBucket: hb(5),
            currentPeriodStart: hb(8),
            lastBilledHourBucket: hb(12),
          }),
        ],
        rollups,
      ),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: hb(13) })

    // MUST BITE: anchoring at currentPeriodStart hb(8) excludes hb(6) → expected 2h
    // vs actual 3h → a spurious 1h drift flagged after every renewal.
    expect(result.driftIncidents).toBe(0)
  })

  it('ignores buckets past the cursor (unbilled is not drift)', async () => {
    // 5 in-period billed (<= cursor) + 5 beyond cursor (not yet billed).
    const rollups = [
      ...Array.from({ length: 5 }, (_, i) => roll('A', i + 1)), // hb 1..5, <= cursor hb(10)? yes
      ...Array.from({ length: 5 }, (_, i) => roll('A', i + 11)), // hb 11..15, > cursor
    ]
    const cron = new BillingReconciliationCron(
      makeDb([sub({ agentHoursUsed: 5, lastBilledHourBucket: hb(10) })], rollups),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: NOW })

    expect(result.driftIncidents).toBe(0)
  })
})

describe('BillingReconciliationCron — cutoff stuck (FASE 2d)', () => {
  it('flags a sub whose oldest unbilled rollup is older than 24h', async () => {
    // Cursor at hb(10); an unbilled bucket at hb(11). now = hb(48) → 37h lag.
    const rollups = [roll('A', 5), roll('A', 11)]
    const cron = new BillingReconciliationCron(
      makeDb([sub({ agentHoursUsed: 5, lastBilledHourBucket: hb(10) })], rollups),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: hb(48) })

    expect(result.cutoffStuckSubs).toBe(1)
  })

  it('does NOT flag a fresh unbilled bucket (within 24h)', async () => {
    // Unbilled bucket at hb(11); now = hb(20) → 9h lag (< 24h).
    const rollups = [roll('A', 5), roll('A', 11)]
    const cron = new BillingReconciliationCron(
      makeDb([sub({ agentHoursUsed: 5, lastBilledHourBucket: hb(10) })], rollups),
      stubLogger,
      null,
    )

    const result = await cron.runOnce({ now: hb(20) })

    expect(result.cutoffStuckSubs).toBe(0)
  })
})

describe('BillingReconciliationCron — invoice duplicates (FASE 2d)', () => {
  it('detects two invoices sharing the same (subscriptionId, period)', async () => {
    const ps = hb(0)
    const pe = hb(720)
    const invoices = [
      { subscriptionId: 'sub_1', periodStart: ps, periodEnd: pe },
      { subscriptionId: 'sub_1', periodStart: ps, periodEnd: pe }, // duplicate
      { subscriptionId: 'sub_2', periodStart: ps, periodEnd: pe }, // unique
    ]
    const cron = new BillingReconciliationCron(makeDb([], [], invoices), stubLogger, null)

    const result = await cron.runOnce({ now: NOW })

    expect(result.invoiceDuplicates).toBe(1)
  })

  it('reports zero duplicates when every invoice period is unique', async () => {
    const invoices = [
      { subscriptionId: 'sub_1', periodStart: hb(0), periodEnd: hb(720) },
      { subscriptionId: 'sub_1', periodStart: hb(720), periodEnd: hb(1440) },
    ]
    const cron = new BillingReconciliationCron(makeDb([], [], invoices), stubLogger, null)

    const result = await cron.runOnce({ now: NOW })

    expect(result.invoiceDuplicates).toBe(0)
  })
})
