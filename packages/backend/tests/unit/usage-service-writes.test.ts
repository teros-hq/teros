/**
 * Contract — UsageService.updateUsage + usage windows (TER-473).
 *
 * El write de presupuesto por canal: $inc exactos de tokens/cost/callCount,
 * inferencia de billingType (provider *oauth* → subscription → cost 0 +
 * ventana rolling), defaults ante modelo desconocido, y el breakdown por
 * categorías. Contra MongoDB real (:27019).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import { UsageService } from '../../src/services/usage-service'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_usage_service_test_${Date.now()}`

let client: MongoClient
let db: Db
let service: UsageService

const USAGE_MODEL = {
  modelId: 'model_sonnet',
  provider: 'anthropic',
  billingType: 'usage',
  context: { maxTokens: 200_000 },
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
}

const SUBSCRIPTION_MODEL = {
  modelId: 'model_claude_max',
  provider: 'anthropic-oauth',
  context: { maxTokens: 200_000 },
  // SIN billingType explícito → inferido 'subscription' por el provider oauth.
  // CON cost informativo en el catálogo (gap S2 del hunt): si el gate de
  // billingType desapareciera, la suscripción FACTURARÍA por token.
  cost: { input: 3, output: 15 },
  quota: { tokensPerWindow: 1_000_000, windowHours: 5 },
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  service = new UsageService(db)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  for (const col of ['conversation_usage', 'usage_windows', 'models']) {
    await db.collection(col).deleteMany({})
  }
  await db.collection('models').insertMany([{ ...USAGE_MODEL }, { ...SUBSCRIPTION_MODEL }])
})

const TOKENS = { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 100_000, cacheWriteTokens: 50_000 }

describe('updateUsage — billing por uso', () => {
  it('acumula tokens/cost/callCount EXACTOS y denormaliza el contexto', async () => {
    const result = await service.updateUsage('ch_1', 'model_sonnet', TOKENS, undefined, {
      userId: 'user_1',
      agentId: 'agent_1',
      workspaceId: 'work_1',
    })

    // cost: 1M×3/M + 200K×15/M + 100K×0.3/M + 50K×3.75/M = 3+3+0.03+0.1875
    expect(result.tokens).toEqual({ input: 1_000_000, output: 200_000, cacheRead: 100_000, cacheWrite: 50_000 })
    expect(result.cost).toBeCloseTo(6.2175, 10)
    expect(result.callCount).toBe(1)
    expect(result.modelId).toBe('model_sonnet')
    expect(result.provider).toBe('anthropic')
    expect(result.contextLimit).toBe(200_000)
    expect(result.lastContextTokens).toBe(1_000_000)
    // biome-ignore lint/suspicious/noExplicitAny: campos denormalizados
    expect((result as any).userId).toBe('user_1')
    // biome-ignore lint/suspicious/noExplicitAny: campos denormalizados
    expect((result as any).agentId).toBe('agent_1')
    // biome-ignore lint/suspicious/noExplicitAny: campos denormalizados
    expect((result as any).workspaceId).toBe('work_1')
  })

  it('la SEGUNDA llamada acumula ($inc) y actualiza lastContextTokens al último', async () => {
    await service.updateUsage('ch_1', 'model_sonnet', TOKENS)
    const result = await service.updateUsage('ch_1', 'model_sonnet', {
      inputTokens: 10,
      outputTokens: 5,
    })

    expect(result.tokens.input).toBe(1_000_010)
    expect(result.tokens.output).toBe(200_005)
    expect(result.callCount).toBe(2)
    expect(result.lastContextTokens).toBe(10) // del ÚLTIMO call, no acumulado
  })

  it('modelo desconocido → defaults (provider unknown, límite 200K, cost 0) sin romper', async () => {
    const result = await service.updateUsage('ch_1', 'modelo-fantasma', TOKENS)
    expect(result.provider).toBe('unknown')
    expect(result.contextLimit).toBe(200_000)
    expect(result.cost).toBe(0)
  })

  it('breakdown: setea SOLO las categorías provistas', async () => {
    await service.updateUsage('ch_1', 'model_sonnet', TOKENS, {
      system: 1000,
      conversation: 5000,
      output: 340,
    })
    const doc = await db.collection('conversation_usage').findOne({ channelId: 'ch_1' })
    expect(doc?.breakdown.system).toBe(1000)
    expect(doc?.breakdown.conversation).toBe(5000)
    expect(doc?.breakdown.output).toBe(340)
    expect(doc?.breakdown.tools ?? 0).toBe(0) // no tocada
  })
})

describe('updateUsage — billing por suscripción (provider oauth)', () => {
  it('cost 0 (la suscripción no factura por token) y abre la ventana rolling', async () => {
    const result = await service.updateUsage('ch_1', 'model_claude_max', TOKENS, undefined, {
      userId: 'user_1',
      agentId: 'agent_1',
    })

    expect(result.cost).toBe(0) // inferido subscription por 'anthropic-oauth'

    const window = await db.collection('usage_windows').findOne({})
    expect(window).not.toBeNull()
    expect(window?.tokensUsed).toBe(1_200_000) // input + output
    expect(window?.tokenLimit).toBe(1_000_000)
    expect(window?.windowHours).toBe(5)
    expect(window?.accountId).toBe('anthropic-oauth-default')
    expect(window?.percentUsed).toBeCloseTo(120, 5)
    expect(window?.byUser.user_1).toBe(1_200_000)
    expect(window?.byAgent.agent_1).toBe(1_200_000)
    // Ventana alineada a límites de 5h: start múltiplo exacto del windowMs
    const windowMs = 5 * 60 * 60 * 1000
    expect(new Date(window?.windowStart).getTime() % windowMs).toBe(0)
    expect(new Date(window?.windowEnd).getTime() - new Date(window?.windowStart).getTime()).toBe(windowMs)
  })

  it('dos llamadas en la MISMA ventana acumulan en el mismo windowId', async () => {
    await service.updateUsage('ch_1', 'model_claude_max', { inputTokens: 100, outputTokens: 50 })
    await service.updateUsage('ch_2', 'model_claude_max', { inputTokens: 200, outputTokens: 25 })

    const windows = await db.collection('usage_windows').find({}).toArray()
    expect(windows).toHaveLength(1)
    expect(windows[0].tokensUsed).toBe(375)
  })

  it('getCurrentWindow devuelve la ventana activa y null si no hay', async () => {
    expect(await service.getCurrentWindow('anthropic-oauth')).toBeNull()
    await service.updateUsage('ch_1', 'model_claude_max', { inputTokens: 100, outputTokens: 0 })
    const window = await service.getCurrentWindow('anthropic-oauth')
    expect(window?.tokensUsed).toBe(100)
  })
})
