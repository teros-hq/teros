/**
 * The billing crons run a first pass shortly after start() instead of waiting a
 * full interval: with a 24h reconciliation interval and a backend restarted more
 * often than that (prod: 94 restarts, 0 reconciliation runs), the safety net
 * never ran. stop() must cancel the pending first pass too.
 */
import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { BillingReconciliationCron } from '../../src/services/billing-reconciliation-cron'
import { BillingResetCron } from '../../src/services/billing-reset-cron'
import { InMemoryDb } from './_stripe-test-helpers'

const SILENT = { info() {}, warn() {}, error() {}, debug() {} } as any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('billing crons: first pass after start()', () => {
  it('reconciliation runs once after initialDelayMs, long before the 24h interval', async () => {
    const db = new InMemoryDb()
    const cron = new BillingReconciliationCron(db as unknown as Db, SILENT, null, null, {
      intervalMs: 60 * 60 * 1000,
      leaderLockTtlMs: 60_000,
      initialDelayMs: 5,
    })
    cron.start()
    await sleep(60)
    cron.stop()
    expect(cron.getMetrics().reconciliation_runs).toBe(1)
  })

  it('reset cron: stop() before the first pass cancels it', async () => {
    const db = new InMemoryDb()
    const cron = new BillingResetCron(db as unknown as Db, SILENT, null, { intervalMs: 60 * 60 * 1000, leaderLockTtlMs: 60_000, initialDelayMs: 30 })
    cron.start()
    cron.stop()
    await sleep(60)
    expect(cron.getMetrics().reset_runs).toBe(0)
  })
})
