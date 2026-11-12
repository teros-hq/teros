/**
 * Tests for user-api.my-usage-channels-summary (WS2) — the batch endpoint
 * behind every agent-hours surface (chat header chip, conversations row, task
 * card badge, task detail row).
 *
 * These MUST BITE: the endpoint's numbers are promised to line up with what
 * the quota discounts, so every billing filter is asserted explicitly:
 *   - userId is FORCED to ctx.userId (a user can never see someone else's use)
 *   - scope = the active subscription's currentPeriodStart (not epoch)
 *   - TER-650 anti-phantom: reconciled_timeout zombies and failed 0-token
 *     sessions never count; a completed 0-token session and a failed session
 *     WITH tokens still bill (same as isNonBillableSession)
 *   - startedAt: null (never ran) and endedAt: null (still open) never count
 *   - demo seeds never count
 *   - SUM semantics: two parallel sessions of 10 min in the same channel
 *     count 20 min (decision #29 — union would say 10)
 *   - the sum across ALL channels equals the user's billable total for the
 *     period (each session belongs to exactly one channel)
 *
 * Hermetic in-memory fake Mongo, same style as billing-tracker.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { createMyUsageChannelsSummaryHandler } from '../../src/handlers/domains/user-api/my-usage'

const MIN = 60_000
const HOUR = 3_600_000

/** Fixed clock anchors so tests are deterministic. */
const PERIOD_START = new Date('2026-10-01T00:00:00Z')
const BEFORE_PERIOD = new Date('2026-09-15T12:00:00Z')
const IN_PERIOD = new Date('2026-10-20T10:00:00Z')

interface SessionDoc {
  sessionUsageId: string
  userId: string
  channelId: string
  startedAt: Date | null
  endedAt: Date | null
  durationMs: number | null
  status: string
  errorKind?: string
  totalTokens: number
  demoSeed?: boolean
}

interface SubDoc {
  userId: string
  status: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
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

/**
 * In-memory fake. Faithful to the handler's read shape:
 *   - billing_subscriptions.findOne({userId, status:'active'})
 *   - agent_usage_sessions.find(filter, {projection}).cursor()
 * The fake applies the filter semantics the driver would (gte / ne null /
 * $in / $ne true) so the handler's query is exercised, not bypassed.
 */
function makeDb(subs: SubDoc[], sessions: SessionDoc[]) {
  const findCalls: any[] = []
  return {
    findCalls,
    collection(name: string) {
      if (name === 'billing_subscriptions') {
        return {
          async findOne(filter: any) {
            return (
              subs.find((s) => s.userId === filter.userId && s.status === filter.status) ?? null
            )
          },
        }
      }
      if (name === 'agent_usage_sessions') {
        return {
          find(filter: any, opts: any) {
            findCalls.push({ filter, opts })
            const rows = sessions.filter((s) => {
              if (filter.userId !== undefined && s.userId !== filter.userId) return false
              if (filter.channelId?.$in && !filter.channelId.$in.includes(s.channelId)) return false
              if (filter.startedAt) {
                if (filter.startedAt.$gte && !(s.startedAt && s.startedAt >= filter.startedAt.$gte))
                  return false
                if (filter.startedAt.$ne === null && s.startedAt === null) return false
              }
              if (filter.endedAt?.$ne === null && s.endedAt === null) return false
              if (filter.demoSeed?.$ne === true && s.demoSeed === true) return false
              return true
            })
            return makeCursor(rows)
          },
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  } as any
}

function ctxFor(userId: string) {
  return { userId, sessionId: 'sess_test', ip: '127.0.0.1' } as any
}

/** A clean billable session in the period. */
function session(partial: Partial<SessionDoc>): SessionDoc {
  return {
    sessionUsageId: `usess_${Math.random().toString(16).slice(2, 10)}`,
    userId: 'user_A',
    channelId: 'ch_1',
    startedAt: IN_PERIOD,
    endedAt: new Date(IN_PERIOD.getTime() + 10 * MIN),
    durationMs: 10 * MIN,
    status: 'completed',
    totalTokens: 500,
    ...partial,
  }
}

const SUB_A: SubDoc = {
  userId: 'user_A',
  status: 'active',
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
}

describe('my-usage-channels-summary — auth', () => {
  it('forces userId = ctx.userId — another user\'s sessions are invisible', async () => {
    const db = makeDb(
      [SUB_A],
      [
        session({ userId: 'user_A', channelId: 'ch_1', durationMs: 10 * MIN }),
        session({ userId: 'user_B', channelId: 'ch_1', durationMs: 99 * HOUR }),
      ],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels['ch_1']).toEqual({ workMs: 10 * MIN, sessions: 1 })
  })

  it('the find() filter carries ctx.userId (defense in depth)', async () => {
    const db = makeDb([SUB_A], [])
    const handler = createMyUsageChannelsSummaryHandler(db)
    await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect((db as any).findCalls[0].filter.userId).toBe('user_A')
  })
})

describe('my-usage-channels-summary — billing filters (must bite)', () => {
  it('TER-650: reconciled_timeout zombie never counts', async () => {
    const db = makeDb(
      [SUB_A],
      [session({ channelId: 'ch_1', errorKind: 'reconciled_timeout', durationMs: 30 * MIN })],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels).toEqual({})
  })

  it('TER-650: failed session with totalTokens === 0 never counts', async () => {
    const db = makeDb(
      [SUB_A],
      [
        session({ channelId: 'ch_1', status: 'errored', totalTokens: 0, durationMs: 5 * MIN }),
        session({ channelId: 'ch_1', status: 'timed_out', totalTokens: 0, durationMs: 5 * MIN }),
        session({ channelId: 'ch_1', status: 'aborted', totalTokens: 0, durationMs: 5 * MIN }),
      ],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels).toEqual({})
  })

  it('TER-650: completed 0-token session STILL bills; failed WITH tokens still bills', async () => {
    const db = makeDb(
      [SUB_A],
      [
        session({ channelId: 'ch_1', status: 'completed', totalTokens: 0, durationMs: 10 * MIN }),
        session({ channelId: 'ch_1', status: 'errored', totalTokens: 42, durationMs: 10 * MIN }),
      ],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels['ch_1']).toEqual({ workMs: 20 * MIN, sessions: 2 })
  })

  it('startedAt: null (never ran) never counts', async () => {
    const db = makeDb(
      [SUB_A],
      [session({ channelId: 'ch_1', startedAt: null, endedAt: null, durationMs: null })],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels).toEqual({})
  })

  it('endedAt: null (still open) never counts — no final duration yet', async () => {
    const db = makeDb(
      [SUB_A],
      [session({ channelId: 'ch_1', endedAt: null, durationMs: null })],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels).toEqual({})
  })

  it('sessions before currentPeriodStart never count (period scope)', async () => {
    const db = makeDb(
      [SUB_A],
      [
        session({ channelId: 'ch_1', startedAt: BEFORE_PERIOD, durationMs: 45 * MIN }),
        session({ channelId: 'ch_1', startedAt: IN_PERIOD, durationMs: 10 * MIN }),
      ],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels['ch_1']).toEqual({ workMs: 10 * MIN, sessions: 1 })
  })

  it('demo seeds never count', async () => {
    const db = makeDb([SUB_A], [session({ channelId: 'ch_1', demoSeed: true, durationMs: HOUR })])
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels).toEqual({})
  })

  it('no active subscription → empty map (no billing period to scope)', async () => {
    const db = makeDb([], [session({ channelId: 'ch_1', durationMs: 10 * MIN })])
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.channels).toEqual({})
  })
})

describe('my-usage-channels-summary — sum semantics (decision #29)', () => {
  it('two PARALLEL sessions of 10 min in one channel → 20 min (sum, not union)', async () => {
    const start = IN_PERIOD
    const db = makeDb(
      [SUB_A],
      [
        session({ channelId: 'ch_1', startedAt: start, durationMs: 10 * MIN }),
        session({
          channelId: 'ch_1',
          startedAt: new Date(start.getTime() + 2 * MIN), // overlaps the first
          durationMs: 10 * MIN,
        }),
      ],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    // Union of the two overlapping intervals would be 12 min — must NOT be that.
    expect(res.channels['ch_1']).toEqual({ workMs: 20 * MIN, sessions: 2 })
  })

  it('groups per channel and only returns the requested channels', async () => {
    const db = makeDb(
      [SUB_A],
      [
        session({ channelId: 'ch_1', durationMs: 10 * MIN }),
        session({ channelId: 'ch_1', durationMs: 20 * MIN }),
        session({ channelId: 'ch_2', durationMs: 30 * MIN }),
        session({ channelId: 'ch_3', durationMs: 40 * MIN }),
      ],
    )
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1', 'ch_2'] })
    expect(res.channels['ch_1']).toEqual({ workMs: 30 * MIN, sessions: 2 })
    expect(res.channels['ch_2']).toEqual({ workMs: 30 * MIN, sessions: 1 })
    expect(res.channels['ch_3']).toBeUndefined()
  })

  it('SUM ACROSS CHANNELS = the user\'s billable total for the period', async () => {
    // The invariant the UI promises: per-channel numbers partition the quota.
    const sessions = [
      session({ channelId: 'ch_1', durationMs: 10 * MIN }),
      session({ channelId: 'ch_1', durationMs: 20 * MIN }),
      session({ channelId: 'ch_2', durationMs: 90 * MIN }),
      session({ channelId: 'ch_3', durationMs: 5 * MIN }),
      // These must NOT be in the total (filters):
      session({ channelId: 'ch_1', errorKind: 'reconciled_timeout', durationMs: HOUR }),
      session({ channelId: 'ch_2', status: 'errored', totalTokens: 0, durationMs: HOUR }),
      session({ channelId: 'ch_3', startedAt: null, endedAt: null, durationMs: null }),
      session({ channelId: 'ch_3', startedAt: BEFORE_PERIOD, durationMs: HOUR }),
      session({ userId: 'user_B', channelId: 'ch_1', durationMs: HOUR }),
    ]
    const db = makeDb([SUB_A], sessions)
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1', 'ch_2', 'ch_3'] })

    const totalFromChannels = Object.values(res.channels).reduce((a, v) => a + v.workMs, 0)
    // Independent re-computation with the same semantics:
    const expectedTotal = sessions
      .filter(
        (s) =>
          s.userId === 'user_A' &&
          s.startedAt !== null &&
          s.startedAt >= PERIOD_START &&
          s.endedAt !== null &&
          s.errorKind !== 'reconciled_timeout' &&
          !(s.totalTokens === 0 && ['errored', 'timed_out', 'aborted'].includes(s.status)),
      )
      .reduce((a, s) => a + (s.durationMs ?? 0), 0)

    expect(totalFromChannels).toBe(expectedTotal)
    expect(totalFromChannels).toBe(125 * MIN)
  })
})

describe('my-usage-channels-summary — input hygiene', () => {
  it('empty / missing / garbage channelIds → empty map, no DB session read', async () => {
    const db = makeDb([SUB_A], [session({ channelId: 'ch_1', durationMs: 10 * MIN })])
    const handler = createMyUsageChannelsSummaryHandler(db)

    expect(await handler(ctxFor('user_A'), {})).toEqual({ channels: {} })
    expect(await handler(ctxFor('user_A'), { channelIds: [] })).toEqual({ channels: {} })
    // Only garbage entries (non-strings / empty strings) → nothing to query.
    expect(await handler(ctxFor('user_A'), { channelIds: [42, null, ''] as any })).toEqual({
      channels: {},
    })
    expect((db as any).findCalls.length).toBe(0)
  })

  it('non-string garbage is dropped but valid ids still go through', async () => {
    const db = makeDb([SUB_A], [session({ channelId: 'ch_1', durationMs: 10 * MIN })])
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1', 42, null, ''] as any })
    expect(res.channels['ch_1']).toEqual({ workMs: 10 * MIN, sessions: 1 })
    expect((db as any).findCalls[0].filter.channelId.$in).toEqual(['ch_1'])
  })

  it('dedupes channelIds and caps the batch at 500', async () => {
    const db = makeDb([SUB_A], [])
    const handler = createMyUsageChannelsSummaryHandler(db)
    const many = [...Array(600).keys()].map((i) => `ch_${i}`)
    await handler(ctxFor('user_A'), { channelIds: [...many, 'ch_1', 'ch_1'] })
    const filter = (db as any).findCalls[0].filter
    expect(filter.channelId.$in.length).toBe(500)
    expect(new Set(filter.channelId.$in).size).toBe(500)
  })

  it('returns periodStart so clients can reason about the scope', async () => {
    const db = makeDb([SUB_A], [session({ channelId: 'ch_1', durationMs: 10 * MIN })])
    const handler = createMyUsageChannelsSummaryHandler(db)
    const res = await handler(ctxFor('user_A'), { channelIds: ['ch_1'] })
    expect(res.periodStart).toEqual(PERIOD_START)
  })
})
