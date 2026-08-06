/**
 * Regression tests for BillingResetCron invoice idempotency (FASE 0a).
 *
 * The reset cron creates an invoice for the ended period and then resets the
 * subscription. If it crashes between the two writes (invoice created, sub not
 * reset) and re-runs, it must NOT create a duplicate invoice.
 *
 * The fake supports BOTH insertOne (always duplicates, the old behavior) and
 * updateOne(upsert) keyed by {subscriptionId, periodStart, periodEnd} (the fix,
 * backed by the unique index). MUST BITE: reverting the cron to insertOne makes
 * the "no duplicate" assertion go to 2 → red.
 */

import { describe, expect, it } from 'bun:test'
import { MongoServerError } from 'mongodb'
import { BillingResetCron } from '../../src/services/billing-reset-cron'
import { boostsCollectionFake } from './_billing-fakes'

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

interface Sub {
  _id: string
  userId: string
  planId: string
  status: string
  customPrice: number | null
  paymentMethod: string
  agentHoursUsed: number
  currentPeriodStart: Date
  currentPeriodEnd: Date
  lastBilledHourBucket?: Date
  resetting?: boolean
  resettingAt?: Date
  cancelAtPeriodEnd?: boolean
  startDate?: Date
  endDate?: Date | null
}

/** Does sub `s` satisfy the claim's $or guard (resetting not-true OR stale)? */
function claimGuardOk(s: Sub, or: any[]): boolean {
  return or.some((cond) => {
    if (cond.resetting && '$ne' in cond.resetting) return s.resetting !== cond.resetting.$ne
    if (cond.resettingAt && '$lt' in cond.resettingAt)
      return s.resettingAt != null && s.resettingAt < cond.resettingAt.$lt
    return false
  })
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

const sameTime = (a: Date, b: Date) => a.getTime() === b.getTime()

function makeDb(subs: Sub[], invoices: any[], snapshots: any[] = [], boosts: any[] = []) {
  return {
    collection(name: string) {
      if (name === 'billing_hour_boosts') {
        return boostsCollectionFake(boosts)
      }
      if (name === 'billing_subscriptions') {
        return {
          find(filter: any) {
            const lt: Date = filter.currentPeriodEnd.$lt
            return makeCursor(subs.filter((s) => s.status === 'active' && s.currentPeriodEnd < lt))
          },
          // Atomic claim: applies $set and returns the post-update doc, honoring
          // the resetting $or guard. Returns null when the guard rejects (already
          // claimed and fresh) — mirrors single-document findOneAndUpdate.
          async findOneAndUpdate(filter: any, update: any, _opts: any) {
            const s = subs.find(
              (x) =>
                x._id === filter._id &&
                x.status === 'active' &&
                x.currentPeriodEnd < filter.currentPeriodEnd.$lt,
            )
            if (!s) return null
            if (filter.$or && !claimGuardOk(s, filter.$or)) return null
            Object.assign(s, update.$set)
            return { ...s }
          },
          async updateOne(filter: any, update: any) {
            const s = subs.find((x) => x._id === filter._id)
            if (!s) return { matchedCount: 0 }
            Object.assign(s, update.$set)
            if (update.$unset) for (const k of Object.keys(update.$unset)) delete (s as any)[k]
            return { matchedCount: 1 }
          },
          async insertOne(doc: any) {
            subs.push(doc)
            return { insertedId: doc._id }
          },
        }
      }
      if (name === 'billing_plans') {
        return {
          async findOne(f: any) {
            return { _id: f._id, price: 89, currency: 'EUR', agentHoursLimit: 80 }
          },
        }
      }
      if (name === 'billing_invoices') {
        return {
          // Non-idempotent path (old behavior): always inserts.
          async insertOne(doc: any) {
            invoices.push(doc)
            return { insertedId: doc._id }
          },
          // Idempotent path (the fix): unique on {subscriptionId, periodStart,
          // periodEnd}. Faithful to the PARTIAL billing_inv_period_unique index:
          // the filter's `kind` (when present) participates in the match, so a
          // boost invoice (kind:'boost') never satisfies a kind:'subscription'
          // period upsert (TER-596 I1).
          async updateOne(filter: any, update: any, opts: any) {
            const exists = invoices.find(
              (i) =>
                i.subscriptionId === filter.subscriptionId &&
                sameTime(i.periodStart, filter.periodStart) &&
                sameTime(i.periodEnd, filter.periodEnd) &&
                (filter.kind === undefined || i.kind === filter.kind),
            )
            if (exists) return { matchedCount: 1, upsertedCount: 0 }
            if (opts?.upsert) {
              const doc = {
                subscriptionId: filter.subscriptionId,
                periodStart: filter.periodStart,
                periodEnd: filter.periodEnd,
                // Mongo seeds equality fields from the filter onto the insert.
                ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
                ...update.$setOnInsert,
              }
              invoices.push(doc)
              // Faithful to the driver: an upsert that inserts returns upsertedId.
              return { matchedCount: 0, upsertedCount: 1, upsertedId: doc._id }
            }
            return { matchedCount: 0, upsertedCount: 0 }
          },
          async findOne(filter: any, _opts?: any) {
            return (
              invoices.find(
                (i) =>
                  i.subscriptionId === filter.subscriptionId &&
                  sameTime(i.periodStart, filter.periodStart) &&
                  sameTime(i.periodEnd, filter.periodEnd) &&
                  (filter.kind === undefined || i.kind === filter.kind),
              ) ?? null
            )
          },
        }
      }
      if (name === 'billing_period_snapshots') {
        return {
          // Append-only with the unique (subscriptionId, periodStart, periodEnd) guard.
          async insertOne(doc: any) {
            const dup = snapshots.find(
              (s) =>
                s.subscriptionId === doc.subscriptionId &&
                sameTime(s.periodStart, doc.periodStart) &&
                sameTime(s.periodEnd, doc.periodEnd),
            )
            if (dup) {
              const err = new MongoServerError({ message: 'E11000 duplicate key' })
              ;(err as any).code = 11000
              throw err
            }
            snapshots.push(doc)
            return { insertedId: doc._id }
          },
        }
      }
      return null as any
    },
  } as any
}

function expiredSub(over: Partial<Sub> = {}): Sub {
  return {
    _id: 'sub_1',
    userId: 'u',
    planId: 'plan_pro',
    status: 'active',
    customPrice: null,
    paymentMethod: 'manual',
    agentHoursUsed: 42,
    currentPeriodStart: new Date('2026-04-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-05-01T00:00:00Z'), // in the past
    lastBilledHourBucket: new Date('2026-04-20T00:00:00Z'),
    ...over,
  }
}

describe('BillingResetCron — invoice idempotency', () => {
  it('creates exactly one invoice and resets the subscription', async () => {
    const sub = expiredSub()
    const invoices: any[] = []
    const cron = new BillingResetCron(makeDb([sub], invoices), stubLogger, null)

    const result = await cron.runOnce()

    expect(result.subscriptionsReset).toBe(1)
    expect(invoices).toHaveLength(1)
    expect(invoices[0].amount).toBe(89)
    // Sub reset: hours zeroed, period advanced, claim released.
    expect(sub.agentHoursUsed).toBe(0)
    expect(sub.resetting).toBe(false)
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(new Date('2026-05-01T00:00:00Z').getTime())
  })

  it('still bills the period when a boost invoice shares it (kind discriminator)', async () => {
    // C2 (TER-596 I1): a boost-purchase invoice copies the active period. The
    // reset-cron must NOT treat it as the period invoice — its upsert filter is
    // scoped to kind:'subscription', so the boost (kind:'boost') is ignored and
    // the period invoice is still created.
    const sub = expiredSub()
    const invoices: any[] = [
      {
        _id: 'boost-purchase:u:r1',
        subscriptionId: 'sub_1',
        userId: 'u',
        kind: 'boost',
        periodStart: sub.currentPeriodStart,
        periodEnd: sub.currentPeriodEnd,
        amount: 30,
        status: 'paid',
      },
    ]
    const cron = new BillingResetCron(makeDb([sub], invoices), stubLogger, null)

    const result = await cron.runOnce()

    expect(result.subscriptionsReset).toBe(1)
    // The period invoice was created alongside the pre-existing boost invoice.
    const periodInv = invoices.find((i) => i.kind === 'subscription')
    expect(periodInv).toBeDefined()
    expect(periodInv.amount).toBe(89)
    expect(invoices).toHaveLength(2)
    // MUST BITE: dropping kind:'subscription' from the cron's upsert filter makes
    // it match the boost invoice → no period invoice → periodInv undefined → red.
  })

  it('PRESERVES lastBilledHourBucket across the reset (kills the historical re-sum)', async () => {
    // The tracker's cutoff is sub.lastBilledHourBucket ?? epoch. If the reset
    // unset it, the next tick would re-sum up to 2 years of TTL-retained
    // rollups into the fresh period. The cursor is a monotonic high-water mark,
    // NOT per-period state, so it must survive the reset untouched.
    const cursor = new Date('2026-04-20T00:00:00Z')
    const sub = expiredSub({ lastBilledHourBucket: cursor })
    const cron = new BillingResetCron(makeDb([sub], []), stubLogger, null)

    await cron.runOnce()

    // MUST BITE: re-adding `$unset lastBilledHourBucket` to the reset makes this
    // undefined → red.
    expect(sub.lastBilledHourBucket).toEqual(cursor)
  })

  it('advances the period end with day-of-month clamping (no Feb overflow)', async () => {
    // Jan 31 + 1 month must clamp to Feb 28, not roll forward to Mar 3.
    const sub = expiredSub({
      currentPeriodStart: new Date('2025-12-31T00:00:00Z'),
      currentPeriodEnd: new Date('2026-01-31T00:00:00Z'),
    })
    const cron = new BillingResetCron(makeDb([sub], []), stubLogger, null)

    await cron.runOnce()

    // Next period: start = old end (Jan 31), end = clamped Feb 28.
    expect(sub.currentPeriodStart).toEqual(new Date('2026-01-31T00:00:00Z'))
    expect(sub.currentPeriodEnd).toEqual(new Date('2026-02-28T00:00:00Z'))
  })

  it('does NOT re-claim a sub already being reset by a live run (mutual exclusion)', async () => {
    // A sub freshly claimed by another worker (resetting:true, recent
    // resettingAt) must be skipped — no second invoice, no double reset.
    const sub = expiredSub({ resetting: true, resettingAt: new Date() })
    const invoices: any[] = []
    const cron = new BillingResetCron(makeDb([sub], invoices), stubLogger, null)

    const result = await cron.runOnce()

    expect(result.subscriptionsReset).toBe(0)
    expect(invoices).toHaveLength(0)
    expect(sub.agentHoursUsed).toBe(42) // untouched
  })

  it('on cancelAtPeriodEnd, closes the sub and opens a Starter sub anchored to day+1', async () => {
    // Deferred cancellation matures: the paid period is invoiced, the sub is
    // closed (ended), and a fresh Starter sub begins on day+1.
    const sub = expiredSub({ cancelAtPeriodEnd: true })
    const subs = [sub]
    const invoices: any[] = []
    const cron = new BillingResetCron(makeDb(subs, invoices), stubLogger, null)

    await cron.runOnce()

    // The completed (paid) period was invoiced.
    expect(invoices).toHaveLength(1)
    // MUST BITE: ignoring cancelAtPeriodEnd renews instead → status stays 'active'.
    expect(sub.status).toBe('ended')
    expect(sub.endDate).toBeInstanceOf(Date)
    // A new active Starter sub was created.
    const starter = subs.find((s) => s.status === 'active')
    expect(starter).toBeDefined()
    expect(starter!.planId).toBe('plan_starter')
    expect(starter!._id).not.toBe(sub._id)
    // Anchored to day+1 of the reset moment.
    expect(starter!.currentPeriodStart.getTime() - starter!.startDate!.getTime()).toBe(86_400_000)
  })

  it('RE-claims a sub abandoned by a crashed reset (stale resettingAt)', async () => {
    // resetting:true but resettingAt older than the stale window → a crashed
    // run; the next run must reclaim and finish it.
    const stale = new Date(Date.now() - 10 * 60 * 1000) // 10 min ago > 5 min window
    const sub = expiredSub({ resetting: true, resettingAt: stale })
    const invoices: any[] = []
    const cron = new BillingResetCron(makeDb([sub], invoices), stubLogger, null)

    const result = await cron.runOnce()

    expect(result.subscriptionsReset).toBe(1)
    expect(invoices).toHaveLength(1)
    expect(sub.agentHoursUsed).toBe(0)
    expect(sub.resetting).toBe(false)
  })

  it('does NOT duplicate the invoice when the cron re-runs after a crash', async () => {
    const sub = expiredSub()
    const invoices: any[] = []
    const db = makeDb([sub], invoices)
    const cron = new BillingResetCron(db, stubLogger, null)

    await cron.runOnce() // invoice created + sub reset
    expect(invoices).toHaveLength(1)

    // Simulate a crash that lost the reset: same period bounds expired again.
    sub.currentPeriodStart = new Date('2026-04-01T00:00:00Z')
    sub.currentPeriodEnd = new Date('2026-05-01T00:00:00Z')
    sub.agentHoursUsed = 42

    await cron.runOnce() // retries the SAME invoice

    // Upsert keyed by period → still one invoice. insertOne would make it 2.
    expect(invoices).toHaveLength(1)
  })
})

describe('BillingResetCron — period snapshots (FASE 2b)', () => {
  it('snapshots the closing period BEFORE zeroing, with the exact payload', async () => {
    const sub = expiredSub({ agentHoursUsed: 42, overageHours: 3 })
    const invoices: any[] = []
    const snapshots: any[] = []
    const cron = new BillingResetCron(makeDb([sub], invoices, snapshots), stubLogger, null)

    await cron.runOnce()

    expect(snapshots).toHaveLength(1)
    const snap = snapshots[0]
    expect(snap.subscriptionId).toBe('sub_1')
    expect(snap.userId).toBe('u')
    expect(snap.planId).toBe('plan_pro')
    expect(snap.periodStart).toEqual(new Date('2026-04-01T00:00:00Z'))
    expect(snap.periodEnd).toEqual(new Date('2026-05-01T00:00:00Z'))
    // The closing period's consumption is captured from the claimed doc.
    // BITE: snapshotting the wrong field (or 0) turns this red.
    expect(snap.agentHoursUsed).toBe(42)
    expect(snap.agentHoursLimit).toBe(80) // effective limit (plan default)
    expect(snap.overageHours).toBe(3)
    // Linked to the invoice created for the same period.
    expect(snap.invoiceId).toBe(invoices[0]._id)
    // The live counter was zeroed afterwards.
    expect(sub.agentHoursUsed).toBe(0)
  })

  it('honors a custom hours limit override in the snapshot', async () => {
    const sub = expiredSub({ agentHoursUsed: 10, customAgentHoursLimit: 150 } as any)
    const snapshots: any[] = []
    const cron = new BillingResetCron(makeDb([sub], [], snapshots), stubLogger, null)

    await cron.runOnce()

    expect(snapshots[0].agentHoursLimit).toBe(150) // override wins over plan's 80
  })

  it('is idempotent: a crash-recovery re-run does NOT duplicate the snapshot', async () => {
    const sub = expiredSub({ agentHoursUsed: 42 })
    const invoices: any[] = []
    const snapshots: any[] = []
    const cron = new BillingResetCron(makeDb([sub], invoices, snapshots), stubLogger, null)

    await cron.runOnce()
    expect(snapshots).toHaveLength(1)

    // Replay the same expired period (lost reset).
    sub.currentPeriodStart = new Date('2026-04-01T00:00:00Z')
    sub.currentPeriodEnd = new Date('2026-05-01T00:00:00Z')
    sub.agentHoursUsed = 42

    const replay = await cron.runOnce()

    // Unique (subscriptionId, periodStart, periodEnd) → still one.
    expect(snapshots).toHaveLength(1)
    // BITE: dropping the local try/catch lets the duplicate-key throw bubble to
    // the per-sub error handler → the sub is never re-reset (replay = 0).
    expect(replay.subscriptionsReset).toBe(1)
    expect(sub.agentHoursUsed).toBe(0)
  })

  it('snapshots the completed period on a deferred cancellation too', async () => {
    const sub = expiredSub({ cancelAtPeriodEnd: true, agentHoursUsed: 17 })
    const snapshots: any[] = []
    const cron = new BillingResetCron(makeDb([sub], [], snapshots), stubLogger, null)

    await cron.runOnce()

    // Snapshot is written before the branch, so cancellation paths capture it.
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].agentHoursUsed).toBe(17)
  })
})

// ── FASE 6: warning flag re-arm + boost expiry + boosted snapshot ────────────
function activeBoost(over: Partial<any> = {}) {
  return {
    _id: 'boost_1',
    userId: 'u',
    subscriptionId: 'sub_1',
    hours: 20,
    periodStart: new Date('2026-04-01T00:00:00Z'),
    periodEnd: new Date('2026-05-01T00:00:00Z'),
    status: 'active',
    grantedBy: 'admin1',
    accessRequestId: 'req_1',
    createdAt: new Date('2026-04-10T00:00:00Z'),
    ...over,
  }
}

describe('BillingResetCron — FASE 6 (warning flag + boosts)', () => {
  it('re-arms the 80% warning on renewal (clears warned80At)', async () => {
    const sub = expiredSub({ warned80At: new Date('2026-04-20T00:00:00Z') } as any)
    const cron = new BillingResetCron(makeDb([sub], [], [], []), stubLogger, null)

    await cron.runOnce()

    // BITE: dropping `warned80At: null` from the renewal $set keeps the old date → red.
    expect((sub as any).warned80At).toBeNull()
    expect(sub.agentHoursUsed).toBe(0) // sanity: it renewed
  })

  it('expires the closed period boosts (active → expired) on renewal', async () => {
    const sub = expiredSub()
    const boosts = [activeBoost()]
    const cron = new BillingResetCron(makeDb([sub], [], [], boosts), stubLogger, null)

    await cron.runOnce()

    // BITE: removing the updateMany expiry sweep keeps it 'active' → red.
    expect(boosts[0].status).toBe('expired')
  })

  it('expires the closed period boosts on a deferred cancellation too', async () => {
    const sub = expiredSub({ cancelAtPeriodEnd: true } as any)
    const boosts = [activeBoost()]
    const cron = new BillingResetCron(makeDb([sub], [], [], boosts), stubLogger, null)

    await cron.runOnce()

    expect(boosts[0].status).toBe('expired')
  })

  it('expires a direct admin grant (source admin_grant, no accessRequestId) too — TER-686', async () => {
    const sub = expiredSub()
    // A TER-686 direct admin grant is structurally identical to any other active
    // boost (status active, pinned to the closing period); the cron must not
    // special-case its origin.
    const boosts = [activeBoost({ _id: 'admin-grant:u:k', source: 'admin_grant', accessRequestId: null })]
    const cron = new BillingResetCron(makeDb([sub], [], [], boosts), stubLogger, null)

    await cron.runOnce()

    expect(boosts[0].status).toBe('expired')
  })

  it('captures the boosted effective limit in the period snapshot', async () => {
    const sub = expiredSub({ agentHoursUsed: 90 })
    const snapshots: any[] = []
    const boosts = [activeBoost({ hours: 20 })]
    const cron = new BillingResetCron(makeDb([sub], [], snapshots, boosts), stubLogger, null)

    await cron.runOnce()

    expect(snapshots).toHaveLength(1)
    // Plan default 80 + active boost 20 = 100. BITE: snapshotting the base limit
    // (without the boost) makes this 80 → red.
    expect(snapshots[0].agentHoursLimit).toBe(100)
  })
})
