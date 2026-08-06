/**
 * Graceful-shutdown drain of the billing crons (FASE 5c).
 *
 * Before: gracefulShutdown called `stop()` (clearInterval only) — a tick in
 * flight could keep writing while the process tore down Mongo, and the leader
 * lock lingered for its full 60s TTL, delaying failover.
 *
 * After: `drain(timeoutMs)` stops scheduling, waits for the in-flight tick to
 * finish, then releases the leader lock — but ONLY when it actually went idle
 * (a still-running tick keeps owning the lock; the TTL covers a force-exit).
 *
 * MUST BITE (confirmed red against mutated source):
 *   - `waitUntilIdle` dropping the deadline check → never returns false on a
 *     stuck tick (the timeout test hangs/red),
 *   - drain releasing the lock unconditionally (drop `if (idle)`) → the lock is
 *     released even when a tick is still running,
 *   - a cron releasing the WRONG lock name → the per-cron assertion red.
 */

import { describe, expect, it } from "bun:test"
import { AgentHoursTracker } from "../../src/services/agent-hours-tracker"
import { BillingChargeCron } from "../../src/services/billing-charge-cron"
import { BillingReconciliationCron } from "../../src/services/billing-reconciliation-cron"
import { BillingResetCron } from "../../src/services/billing-reset-cron"
import { waitUntilIdle } from "../../src/lib/drain"
import { LEADER_LOCKS } from "../../src/services/leader-election"
import { InMemoryDb } from "./_stripe-test-helpers"

const noopLog = {
  error() {},
  info() {},
  warn() {},
  debug() {},
  child() {
    return noopLog
  },
} as any

function fakeLeader(released: string[]) {
  return {
    async tryAcquire() {
      return true
    },
    async heartbeat() {
      return true
    },
    async release(name: string) {
      released.push(name)
    },
  } as any
}

const disabledStripe = { isEnabled: () => false } as any

describe("waitUntilIdle", () => {
  it("returns true immediately when already idle", async () => {
    expect(await waitUntilIdle(() => false, { timeoutMs: 1000 })).toBe(true)
  })

  it("returns true once isRunning flips to false before the deadline", async () => {
    let remaining = 3
    const ok = await waitUntilIdle(
      () => {
        remaining -= 1
        return remaining > 0
      },
      { timeoutMs: 1000, pollMs: 1 },
    )
    expect(ok).toBe(true)
  })

  it("returns false when still running at the timeout", async () => {
    expect(await waitUntilIdle(() => true, { timeoutMs: 30, pollMs: 5 })).toBe(false)
  })
})

describe("cron drain", () => {
  it("goes idle and releases the matching leader lock for each billing cron", async () => {
    const db = new InMemoryDb() as any
    // Each cron gets a capturing leader so we can assert the exact lock name it
    // releases on drain — a cron releasing the wrong lock would defeat failover.
    const tracksReleased: string[][] = []
    const built = [
      (() => {
        const r: string[] = []
        tracksReleased.push(r)
        return { cron: new AgentHoursTracker(db, noopLog, fakeLeader(r)), lock: LEADER_LOCKS.AgentHoursTracker }
      })(),
      (() => {
        const r: string[] = []
        tracksReleased.push(r)
        return { cron: new BillingResetCron(db, noopLog, fakeLeader(r)), lock: LEADER_LOCKS.BillingResetCron }
      })(),
      (() => {
        const r: string[] = []
        tracksReleased.push(r)
        return {
          cron: new BillingReconciliationCron(db, noopLog, fakeLeader(r)),
          lock: LEADER_LOCKS.BillingReconciliation,
        }
      })(),
      (() => {
        const r: string[] = []
        tracksReleased.push(r)
        return {
          cron: new BillingChargeCron(db, noopLog, disabledStripe, fakeLeader(r)),
          lock: LEADER_LOCKS.BillingChargeCron,
        }
      })(),
    ]
    for (let i = 0; i < built.length; i++) {
      const { cron, lock } = built[i]
      expect(await cron.drain(1000)).toBe(true)
      expect(tracksReleased[i]).toEqual([lock])
    }
  })

  it("returns false and does NOT release the lock if a tick is still running at timeout", async () => {
    const db = new InMemoryDb() as any
    const released: string[] = []
    const cron = new BillingResetCron(db, noopLog, fakeLeader(released))
    // Simulate a tick still in flight at shutdown.
    ;(cron as unknown as { running: boolean }).running = true
    expect(await cron.drain(30)).toBe(false)
    expect(released).toEqual([]) // the running tick still owns the lock
  })

  it("drain without a leader is a no-op release (does not throw)", async () => {
    const db = new InMemoryDb() as any
    const cron = new BillingResetCron(db, noopLog) // leader = null
    expect(await cron.drain(1000)).toBe(true)
  })
})
