/**
 * Contract — UsageTrackingService.trackUsage (TER-473 / TER-666).
 *
 * The write to `llm_usage` is the billing/audit record. After TER-666 its cost
 * comes from the SHARED `estimateCostBreakdownUsd` (owned + ai-tokenizer pricing),
 * the SAME source the session projection uses — NOT the unpopulated `models.cost`
 * column. This test pins that consolidation: cost == estimateCostUsd for the same
 * inputs, reasoning is never double-charged, subscription providers cost 0, and a
 * failed insert never throws. Against real ephemeral Mongo.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { estimateCostUsd } from '@teros/core'
import { type Db, MongoClient } from 'mongodb'
import { UsageTrackingService } from '../../src/services/usage-tracking-service'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_usage_tracking_test_${Date.now()}`

let client: MongoClient
let db: Db
let service: UsageTrackingService

// Priceable via ai-tokenizer. The bogus `cost` proves models.cost is IGNORED now
// (pricing comes from estimateCostBreakdownUsd, not this column).
const MODEL = {
  modelId: 'claude-3-haiku',
  provider: 'anthropic',
  billingType: 'usage',
  cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
}

// ai-tokenizer claude-3-haiku rates ($/token), pinned in token-counter.test.ts.
const IN = 2.5e-7
const OUT = 1.25e-6
const CACHE_READ = 3e-8
const CACHE_WRITE = 3e-7

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  service = new UsageTrackingService(db)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  await db.collection('llm_usage').deleteMany({})
  await db.collection('models').deleteMany({})
  await db.collection('models').insertOne({ ...MODEL })
})

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user_1',
    workspaceId: 'work_1',
    agentId: 'agent_1',
    coreId: 'core_1',
    channelId: 'ch_1',
    messageId: 'msg_1',
    provider: 'anthropic' as const,
    modelId: 'claude-3-haiku',
    modelString: 'claude-3-haiku',
    promptTokens: 1_000_000,
    completionTokens: 200_000,
    totalTokens: 1_200_000,
    ...overrides,
  }
}

describe('trackUsage', () => {
  it('prices from the shared cost source (owned/ai-tokenizer), IGNORING models.cost', async () => {
    const result = await service.trackUsage(
      baseParams({
        sessionUsageId: 'susage_1',
        cacheReadTokens: 500_000,
        cacheWriteTokens: 100_000,
        stopReason: 'end_turn',
        latencyMs: 1234,
        generationId: 'gen_x',
      }),
    )

    expect(result.costInput).toBeCloseTo(1_000_000 * IN, 10) // 0.25 (NOT the 999 in models.cost)
    expect(result.costOutput).toBeCloseTo(200_000 * OUT, 10) // 0.25
    expect(result.costCacheRead).toBeCloseTo(500_000 * CACHE_READ, 10) // 0.015
    expect(result.costCacheWrite).toBeCloseTo(100_000 * CACHE_WRITE, 10) // 0.03
    expect(result.costReasoning).toBeUndefined()
    expect(result.costRequest).toBeUndefined()
    expect(result.costTotal).toBeCloseTo(0.25 + 0.25 + 0.015 + 0.03, 10)
    expect(result.currency).toBe('USD')
    expect(result.billingType).toBe('usage')
    expect(result.usageId).toMatch(/^usage_/)

    const saved = await db.collection('llm_usage').findOne({ usageId: result.usageId })
    expect(saved?.costTotal).toBeCloseTo(0.545, 10)
    expect(saved?.sessionUsageId).toBe('susage_1')
    expect(saved?.stopReason).toBe('end_turn')
  })

  it('llm_usage cost EQUALS estimateCostUsd for the same inputs (one source of truth)', async () => {
    // The invariant that would have caught the divergence: the billing record and
    // the session projection must never disagree, because both call the same fn.
    const params = baseParams({ cacheReadTokens: 300_000, cacheWriteTokens: 50_000 })
    const result = await service.trackUsage(params)
    const expected = estimateCostUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: params.promptTokens,
      outputTokens: params.completionTokens,
      cachedReadTokens: 300_000,
      cachedWriteTokens: 50_000,
      billingType: 'usage',
    })
    expect(result.costTotal).toBeCloseTo(expected!, 12)
  })

  it('does NOT double-charge reasoning tokens (they are already in output)', async () => {
    // Old behavior charged reasoning at the output rate on top of output → double.
    const result = await service.trackUsage(
      baseParams({ promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 1_000_000 }),
    )
    expect(result.costReasoning).toBeUndefined()
    expect(result.costTotal).toBe(0) // no output tokens → no cost; reasoning adds nothing
  })

  it('subscription provider (zhipu-coding) → cost 0, no phantom per-token charge', async () => {
    await db.collection('models').insertOne({ modelId: 'glm-5.2-coding', provider: 'zhipu-coding', billingType: 'subscription' })
    const result = await service.trackUsage(
      baseParams({ provider: 'zhipu-coding' as any, modelId: 'glm-5.2-coding', modelString: 'glm-5.2-coding' }),
    )
    expect(result.costTotal).toBe(0)
  })

  it('unpriced model → cost 0 (warn, no throw); record still persisted', async () => {
    const result = await service.trackUsage(baseParams({ modelId: 'modelo-fantasma', provider: 'openrouter' as any }))
    expect(result.costInput).toBe(0)
    expect(result.costTotal).toBe(0)
    expect(result.billingType).toBeUndefined()
    expect(await db.collection('llm_usage').countDocuments({})).toBe(1)
  })

  it('fail-safe: an insert that throws NEVER propagates (the LLM call is not broken)', async () => {
    const broken = {
      collection: (name: string) =>
        name === 'llm_usage'
          ? { insertOne: async () => { throw new Error('mongo down') } }
          : { findOne: async () => MODEL },
      // biome-ignore lint/suspicious/noExplicitAny: fake puntual
    } as any
    const svc = new UsageTrackingService(broken)
    const result = await svc.trackUsage(baseParams())
    expect(result.costTotal).toBeCloseTo(1_000_000 * IN + 200_000 * OUT, 10) // still computed
  })
})

describe('getUsageSummary', () => {
  it('aggregates cost/tokens/generations by provider and model', async () => {
    await service.trackUsage(baseParams())
    await service.trackUsage(baseParams({ modelId: 'modelo-fantasma', provider: 'openrouter' as any }))

    const summary = await service.getUsageSummary({ userId: 'user_1' })
    const priced = 1_000_000 * IN + 200_000 * OUT // 0.5
    expect(summary.totalGenerations).toBe(2)
    expect(summary.totalTokens).toBe(2_400_000)
    expect(summary.totalCost).toBeCloseTo(priced, 10) // the unpriced one adds 0
    expect(summary.byProvider.anthropic.generations).toBe(1)
    expect(summary.byProvider.openrouter.generations).toBe(1)
    expect(summary.byModel['claude-3-haiku'].cost).toBeCloseTo(priced, 10)
  })
})
