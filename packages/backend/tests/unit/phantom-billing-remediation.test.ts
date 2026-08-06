/**
 * PhantomBillingRemediation — reverse phantom-session over-billing (TER-652).
 *
 * Against MongoDB real (:27019). Simulates the pre-fix state — a user_hourly
 * rollup that INCLUDES a phantom session's wall-clock plus a subscription whose
 * agentHoursUsed was inflated by it — then remediates and asserts the counter is
 * corrected down to the real work, the rollup is recomputed (phantom gone), a
 * corrective ledger entry is written, and a re-run is a no-op.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import { PhantomBillingRemediation } from '../../src/services/phantom-billing-remediation'
import type { AgentUsageSession } from '../../src/types/database'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27019'
const DB_NAME = `teros_phantom_remediation_test_${Date.now()}`

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

const HOUR = new Date('2026-05-20T10:00:00Z')
const HOUR_MS = 3_600_000
const REAL_MS = 30_000 // real session: 30s
const PHANTOM_MS = 1_170_000 // phantom: 19.5 min

let client: MongoClient
let db: Db

function makeSession(overrides: Partial<AgentUsageSession>): AgentUsageSession {
  return {
    sessionUsageId: 'usess_x',
    parentSessionUsageId: null,
    triggerKind: 'user_message',
    userId: 'user_1',
    agentId: 'agent_1',
    workspaceId: 'work_1',
    channelId: 'ch_1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    actualModel: undefined,
    startedAt: new Date('2026-05-20T10:00:00Z'),
    endedAt: new Date('2026-05-20T10:00:30Z'),
    durationMs: REAL_MS,
    durationSource: 'monotonic',
    status: 'completed',
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 150,
    costUsd: 0.01,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentUsageSession
}

async function seedInflatedRollup(userActiveMs: number) {
  // Pre-fix rollup: userActiveMs includes the phantom wall-clock.
  await db.collection('agent_usage_rollups_user_hourly').insertOne({
    rollupId: 'usro_seed',
    hourBucket: HOUR,
    groupKey: { userId: 'user_1', workspaceId: 'work_1' },
    userActiveMs,
    sessionCount: 2,
    totalTokens: 150,
    costUsd: 0.01,
    computedAt: new Date(),
    jobRunId: 'seed',
    schemaVersion: 1,
    createdAt: new Date(),
  })
}

async function seedSubscription(agentHoursUsed: number) {
  await db.collection('billing_subscriptions').insertOne({
    _id: 'sub_1',
    userId: 'user_1',
    planId: 'plan_pro',
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed,
    overageHours: 0,
    // Billed range covers HOUR: anchor < HOUR <= cutoff.
    periodStartBucket: new Date('2026-05-20T09:00:00Z'),
    lastBilledHourBucket: new Date('2026-05-20T11:00:00Z'),
    currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
    status: 'active',
    paymentMethod: 'manual',
    startDate: new Date('2026-05-01T00:00:00Z'),
    endDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any)
}

async function seedSessions() {
  // Real 30s session + phantom 19.5min reconciled_timeout (0 tokens), disjoint.
  await db.collection('agent_usage_sessions').insertMany([
    makeSession({
      sessionUsageId: 'usess_real',
      startedAt: new Date('2026-05-20T10:30:00Z'),
      endedAt: new Date('2026-05-20T10:30:30Z'),
      durationMs: REAL_MS,
      totalTokens: 150,
    }),
    makeSession({
      sessionUsageId: 'usess_phantom',
      status: 'timed_out',
      errorKind: 'reconciled_timeout',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:19:30Z'),
      durationMs: PHANTOM_MS,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    } as Partial<AgentUsageSession>),
  ])
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  // Unique index that makes the corrective ledger entry idempotent.
  await db
    .collection('billing_hour_ledger')
    .createIndex({ subscriptionId: 1, hourBucket: 1 }, { unique: true })
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  for (const c of [
    'agent_usage_sessions',
    'agent_usage_rollups_user_hourly',
    'agent_usage_rollups_hourly',
    'billing_subscriptions',
    'billing_hour_ledger',
  ]) {
    await db.collection(c).deleteMany({})
  }
})

const since = new Date('2026-05-20T00:00:00Z')

describe('PhantomBillingRemediation (real Mongo)', () => {
  it('dry-run reports the phantom hours but writes nothing', async () => {
    const inflatedHours = (REAL_MS + PHANTOM_MS) / HOUR_MS
    await seedSessions()
    await seedInflatedRollup(REAL_MS + PHANTOM_MS)
    await seedSubscription(inflatedHours)

    const report = await new PhantomBillingRemediation(db, stubLogger).run({ since, dryRun: true })

    expect(report.subsCorrected).toBe(1)
    // Phantom hours ≈ 19.5min; the real 30s stays billable.
    expect(report.totalHoursReturned).toBeCloseTo(PHANTOM_MS / HOUR_MS, 6)
    // Nothing written: counter, rollup and ledger untouched.
    const sub = await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' })
    expect(sub?.agentHoursUsed).toBeCloseTo(inflatedHours, 9)
    const rollup = await db
      .collection('agent_usage_rollups_user_hourly')
      .findOne({ hourBucket: HOUR })
    expect(rollup?.userActiveMs).toBe(REAL_MS + PHANTOM_MS)
    expect(await db.collection('billing_hour_ledger').countDocuments()).toBe(0)
  })

  it('apply corrects agentHoursUsed down to the real work, recomputes the rollup, writes a ledger entry', async () => {
    const inflatedHours = (REAL_MS + PHANTOM_MS) / HOUR_MS
    await seedSessions()
    await seedInflatedRollup(REAL_MS + PHANTOM_MS)
    await seedSubscription(inflatedHours)

    const report = await new PhantomBillingRemediation(db, stubLogger).run({ since, dryRun: false })

    expect(report.subsCorrected).toBe(1)
    // Counter down to the real 30s.
    const sub = await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' })
    expect(sub?.agentHoursUsed).toBeCloseTo(REAL_MS / HOUR_MS, 6)
    // Rollup recomputed WITHOUT the phantom.
    const rollup = await db
      .collection('agent_usage_rollups_user_hourly')
      .findOne({ hourBucket: HOUR })
    expect(rollup?.userActiveMs).toBe(REAL_MS)
    // Corrective ledger entry (negative hoursAdded).
    const ledger = await db.collection('billing_hour_ledger').findOne({ subscriptionId: 'sub_1' })
    expect(ledger?.hoursAdded).toBeCloseTo(-(PHANTOM_MS / HOUR_MS), 6)
  })

  it('is idempotent: a second apply does not double-correct', async () => {
    const inflatedHours = (REAL_MS + PHANTOM_MS) / HOUR_MS
    await seedSessions()
    await seedInflatedRollup(REAL_MS + PHANTOM_MS)
    await seedSubscription(inflatedHours)

    const remediation = new PhantomBillingRemediation(db, stubLogger)
    await remediation.run({ since, dryRun: false })
    const afterFirst = (await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' }))
      ?.agentHoursUsed

    // Second run: rollup already corrected → no phantom measured → no-op.
    const report2 = await remediation.run({ since, dryRun: false })
    expect(report2.subsCorrected).toBe(0)
    const afterSecond = (await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' }))
      ?.agentHoursUsed
    expect(afterSecond).toBeCloseTo(afterFirst as number, 9)
    expect(await db.collection('billing_hour_ledger').countDocuments()).toBe(1)
  })

  it('does NOT correct a bucket outside the billed range (past the cursor)', async () => {
    const inflatedHours = (REAL_MS + PHANTOM_MS) / HOUR_MS
    await seedSessions()
    await seedInflatedRollup(REAL_MS + PHANTOM_MS)
    // Cutoff BEFORE the phantom's hour → the phantom was never billed into this
    // period's counter, so remediation must leave it alone.
    await db.collection('billing_subscriptions').insertOne({
      _id: 'sub_1',
      userId: 'user_1',
      planId: 'plan_pro',
      customAgentHoursLimit: null,
      customPrice: null,
      customPriceNote: null,
      agentHoursUsed: inflatedHours,
      overageHours: 0,
      periodStartBucket: new Date('2026-05-20T09:00:00Z'),
      lastBilledHourBucket: new Date('2026-05-20T09:00:00Z'), // < HOUR
      currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      status: 'active',
      paymentMethod: 'manual',
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)

    const report = await new PhantomBillingRemediation(db, stubLogger).run({ since, dryRun: false })
    expect(report.subsCorrected).toBe(0)
    const sub = await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' })
    expect(sub?.agentHoursUsed).toBeCloseTo(inflatedHours, 9)
  })
})
