/**
 * Unit — AutomateQuotaService: cuota diaria de ejecuciones por plan.
 *
 * Cubre:
 *   1. Límite efectivo: plan, override por suscripción, 0 = sin límite,
 *      usuario sin suscripción → plan por defecto (Seed).
 *   2. Contador: solo ejecuciones que corrieron (refused no cuenta), de
 *      cualquier starter/workspace del mismo creador, desde las 00:00Z.
 *   3. Integración con el runner: al agotar la cuota la ejecución se
 *      rechaza, se registra como refused con el motivo, y NO incrementa el
 *      contador de fallos ni desactiva el starter.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import migration from '../../src/migrations/20261015_001_automate_daily_execution_limits'
import { AutomateModel } from '../../src/models/automate'
import {
  AUTOMATE_DAILY_EXECUTION_LIMITS,
  BILLING_PLANS_SEED,
  DEFAULT_PLAN_ID,
  getEffectiveAutomateDailyLimit,
  seedBillingPlans,
} from '../../src/models/billing'
import {
  AUTOMATE_QUOTA_REASON,
  type AutomateQuotaExhaustedNotice,
  AutomateQuotaService,
  nextUtcMidnight,
  startOfUtcDay,
} from '../../src/services/automate-quota'
import { AutomateRunner } from '../../src/services/automate-runner'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_quota_test_${Date.now()}`

const WS = 'work_quota_test'
const AGENT = 'agent_quota_test'
const CHANNEL = 'ch_quota_test'

let client: MongoClient
let db: Db
let model: AutomateModel
let quota: AutomateQuotaService
let injected = 0

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  model = new AutomateModel(db)
  await model.ensureIndexes()
  await seedBillingPlans(db)
  quota = new AutomateQuotaService(db, model)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  injected = 0
  await db.collection('automate_starters').deleteMany({})
  await db.collection('automate_executions').deleteMany({})
  await db.collection('billing_subscriptions').deleteMany({})
})

async function subscribe(userId: string, planId: string, extra: Record<string, unknown> = {}) {
  await db.collection('billing_subscriptions').insertOne({
    _id: `sub_${userId}_${planId}` as never,
    userId,
    planId,
    status: 'active',
    customAgentHoursLimit: null,
    agentHoursUsed: 0,
    ...extra,
  })
}

async function ranExecution(starterId: string, createdBy: string, opts: { createdAt?: string; refused?: boolean; workspaceId?: string } = {}) {
  await db.collection('automate_executions').insertOne({
    executionId: `autoexec_${Math.random().toString(36).slice(2)}`,
    starterId,
    workspaceId: opts.workspaceId ?? WS,
    source: 'scheduler',
    ok: true,
    createdBy,
    ...(opts.refused ? { refused: true } : {}),
    createdAt: opts.createdAt ?? new Date().toISOString(),
  })
}

function makeStarter(createdBy: string) {
  return model.createStarter({
    name: `Starter de ${createdBy}`,
    createdBy,
    workspaceId: WS,
    trigger: { type: 'scheduler', cronExpression: '* * * * *' },
    action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'tick' },
  })
}

// ===========================================================================
// Límite efectivo
// ===========================================================================

describe('límite efectivo por plan', () => {
  it('el catálogo seed lleva la tabla de límites (Seed 5 · Starter 20 · Growth 50 · Pro 100 · Ultra 200 · Enterprise 0)', () => {
    for (const plan of BILLING_PLANS_SEED) {
      expect(plan.automateDailyExecutionLimit).toBe(AUTOMATE_DAILY_EXECUTION_LIMITS[plan._id])
    }
    expect(AUTOMATE_DAILY_EXECUTION_LIMITS).toEqual({
      plan_seed: 5,
      plan_starter: 20,
      plan_growth: 50,
      plan_pro: 100,
      plan_ultra: 200,
      plan_enterprise: 0,
    })
  })

  it('getEffectiveAutomateDailyLimit: override de suscripción > plan; sin campo = 0 (sin límite)', () => {
    expect(getEffectiveAutomateDailyLimit(null, { automateDailyExecutionLimit: 5 })).toBe(5)
    expect(getEffectiveAutomateDailyLimit({ customAutomateDailyExecutionLimit: null }, { automateDailyExecutionLimit: 5 })).toBe(5)
    expect(getEffectiveAutomateDailyLimit({ customAutomateDailyExecutionLimit: 42 }, { automateDailyExecutionLimit: 5 })).toBe(42)
    expect(getEffectiveAutomateDailyLimit({ customAutomateDailyExecutionLimit: 0 }, { automateDailyExecutionLimit: 5 })).toBe(0)
    expect(getEffectiveAutomateDailyLimit(null, {})).toBe(0)
  })

  it('usuario sin suscripción activa → límite del plan por defecto (Seed)', async () => {
    const status = await quota.getStatus('u_nadie')
    expect(status.limit).toBe(AUTOMATE_DAILY_EXECUTION_LIMITS[DEFAULT_PLAN_ID])
    expect(status.used).toBe(0)
    expect(status.planName).toBe('Seed')
  })

  it('usuario con suscripción → límite de su plan; Enterprise sin límite', async () => {
    await subscribe('u_growth', 'plan_growth')
    await subscribe('u_ent', 'plan_enterprise')
    expect((await quota.getStatus('u_growth')).limit).toBe(50)
    expect((await quota.getStatus('u_ent')).limit).toBe(0)
  })

  it('la migración estampa el campo en los planes existentes (seed solo hace $setOnInsert)', async () => {
    await db.collection('billing_plans').updateMany({}, { $unset: { automateDailyExecutionLimit: '' } })
    expect((await quota.getStatus('u_nadie')).limit).toBe(0)
    await migration.up(db)
    expect((await quota.getStatus('u_nadie')).limit).toBe(5)
    const growth = await db.collection('billing_plans').findOne({ _id: 'plan_growth' as never })
    expect(growth!.automateDailyExecutionLimit).toBe(50)
  })
})

// ===========================================================================
// Contador diario
// ===========================================================================

describe('contador diario', () => {
  it('startOfUtcDay devuelve las 00:00:00.000Z del día', () => {
    expect(startOfUtcDay(new Date('2026-10-15T23:59:59.999Z'))).toBe('2026-10-15T00:00:00.000Z')
    expect(startOfUtcDay(new Date('2026-10-15T00:00:00.000Z'))).toBe('2026-10-15T00:00:00.000Z')
  })

  it('cuenta ejecuciones de hoy de todos los starters del creador, no las de ayer ni las refused ni las de otros', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    await ranExecution('s1', 'u1')
    await ranExecution('s2', 'u1', { workspaceId: 'otro_ws' })
    await ranExecution('s1', 'u1', { refused: true })
    await ranExecution('s1', 'u1', { createdAt: yesterday })
    await ranExecution('s3', 'u2')

    expect(await model.countExecutionsByCreatorSince('u1', startOfUtcDay())).toBe(2)
    expect(await model.countExecutionsByCreatorSince('u2', startOfUtcDay())).toBe(1)
  })

  it('check: permite por debajo del límite, rechaza al alcanzarlo con motivo y countsAsFailure=false', async () => {
    await subscribe('u1', 'plan_seed')
    const starter = await makeStarter('u1')
    for (let i = 0; i < 4; i++) await ranExecution(starter.starterId, 'u1')
    expect((await quota.check(starter)).allowed).toBe(true)

    await ranExecution(starter.starterId, 'u1')
    const verdict = await quota.check(starter)
    expect(verdict.allowed).toBe(false)
    expect(verdict.countsAsFailure).toBe(false)
    expect(verdict.reason).toStartWith(`${AUTOMATE_QUOTA_REASON}: 5/5`)
    expect(verdict.reason).toContain('Seed')
  })

  it('check: el override de suscripción manda sobre el plan', async () => {
    await subscribe('u1', 'plan_seed', { customAutomateDailyExecutionLimit: 2 })
    const starter = await makeStarter('u1')
    await ranExecution(starter.starterId, 'u1')
    expect((await quota.check(starter)).allowed).toBe(true)
    await ranExecution(starter.starterId, 'u1')
    expect((await quota.check(starter)).allowed).toBe(false)
  })

  it('check: plan sin límite (0) nunca rechaza', async () => {
    await subscribe('u1', 'plan_enterprise')
    const starter = await makeStarter('u1')
    for (let i = 0; i < 300; i++) await ranExecution(starter.starterId, 'u1')
    expect((await quota.check(starter)).allowed).toBe(true)
  })
})

// ===========================================================================
// Integración con el runner
// ===========================================================================

describe('runner + cuota', () => {
  function makeRunner() {
    const runner = new AutomateRunner({
      db,
      model,
      boardService: {} as never,
      pubSubService: null,
      handleScheduledEvent: async () => {
        injected++
        return { success: true }
      },
      actionBridgeManager: null,
    })
    runner.setCanExecute((starter) => quota.check(starter))
    return runner
  }

  it('las ejecuciones reales se estampan con createdBy y consumen cuota; la sexta se rechaza sin tocar el failure cap', async () => {
    await subscribe('u1', 'plan_seed')
    const runner = makeRunner()
    const a = await makeStarter('u1')
    const b = await makeStarter('u1')

    // 5 ejecuciones repartidas entre dos starters del mismo creador.
    for (let i = 0; i < 3; i++) expect((await runner.executeAction(a, { source: 'scheduler' })).ok).toBe(true)
    for (let i = 0; i < 2; i++) expect((await runner.executeAction(b, { source: 'scheduler' })).ok).toBe(true)
    expect(injected).toBe(5)

    const rows = await db.collection('automate_executions').find({ createdBy: 'u1' }).toArray()
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.refused === undefined)).toBe(true)

    // Sexta: rechazada, registrada como refused, agente no despertado.
    const refused = await runner.executeAction(a, { source: 'scheduler' })
    expect(refused.ok).toBe(false)
    expect(refused.error).toStartWith(AUTOMATE_QUOTA_REASON)
    expect(injected).toBe(5)

    const refusedRow = await db.collection('automate_executions').findOne({ starterId: a.starterId, ok: false })
    expect(refusedRow!.refused).toBe(true)
    expect(refusedRow!.createdBy).toBe('u1')

    // Los rechazos no cuentan como fallos: ni consecutiveFailures ni disable,
    // por muchos que haya (un cron cada minuto rechazado todo el día).
    for (let i = 0; i < 10; i++) await runner.executeAction(a, { source: 'scheduler' })
    const s = await model.getStarterById(a.starterId)
    expect(s!.enabled).toBe(true)
    expect(s!.consecutiveFailures ?? 0).toBe(0)
    expect((await quota.getStatus('u1')).used).toBe(5)
  })

  it('un rechazo de billing sigue contando como fallo (comportamiento previo intacto)', async () => {
    const runner = makeRunner()
    runner.setCanExecute(async () => ({ allowed: false, reason: 'billing-hours_exhausted' }))
    const a = await makeStarter('u1')
    await runner.executeAction(a, { source: 'scheduler' })
    const s = await model.getStarterById(a.starterId)
    expect(s!.consecutiveFailures).toBe(1)
    const row = await db.collection('automate_executions').findOne({ starterId: a.starterId })
    expect(row!.refused).toBe(true)
  })

  it('otro usuario con otro plan tiene su propia cuota', async () => {
    await subscribe('u1', 'plan_seed')
    await subscribe('u2', 'plan_starter')
    const runner = makeRunner()
    const a = await makeStarter('u1')
    const b = await makeStarter('u2')
    for (let i = 0; i < 5; i++) await runner.executeAction(a, { source: 'event', topic: 'x.y', payload: {} })
    expect((await runner.executeAction(a, { source: 'event', topic: 'x.y', payload: {} })).ok).toBe(false)
    for (let i = 0; i < 20; i++) expect((await runner.executeAction(b, { source: 'webhook', payload: {} })).ok).toBe(true)
    expect((await runner.executeAction(b, { source: 'webhook', payload: {} })).ok).toBe(false)
  })
})

// ===========================================================================
// Estado y aviso único por día
// ===========================================================================

describe('estado y aviso de agotamiento', () => {
  it('getStatus expone restantes, exhausted y la hora de reset (siguiente 00:00Z)', async () => {
    await subscribe('u1', 'plan_starter')
    const now = new Date('2026-10-15T17:30:00.000Z')
    await ranExecution('s1', 'u1', { createdAt: '2026-10-15T09:00:00.000Z' })
    const status = await quota.getStatus('u1', now)
    expect(status).toEqual({
      limit: 20,
      used: 1,
      remaining: 19,
      exhausted: false,
      planId: 'plan_starter',
      planName: 'Starter',
      resetsAt: '2026-10-16T00:00:00.000Z',
    })
    expect(nextUtcMidnight(new Date('2026-12-31T23:59:59.000Z'))).toBe('2027-01-01T00:00:00.000Z')
    await subscribe('u_ent', 'plan_enterprise')
    expect((await quota.getStatus('u_ent')).remaining).toBeNull()
  })

  it('el primer rechazo del día dispara onExhausted UNA vez con el starter y los más activos; los siguientes callan', async () => {
    await subscribe('u1', 'plan_seed')
    const notices: AutomateQuotaExhaustedNotice[] = []
    quota.setOnExhausted(async (_starter, notice) => {
      notices.push(notice)
    })
    try {
      const runner = new AutomateRunner({
        db,
        model,
        boardService: {} as never,
        pubSubService: null,
        handleScheduledEvent: async () => ({ success: true }),
        actionBridgeManager: null,
      })
      runner.setCanExecute((starter) => quota.check(starter))
      const a = await makeStarter('u1')
      const b = await makeStarter('u1')
      for (let i = 0; i < 4; i++) await runner.executeAction(a, { source: 'scheduler' })
      await runner.executeAction(b, { source: 'scheduler' })
      expect(notices).toHaveLength(0)

      for (let i = 0; i < 3; i++) await runner.executeAction(b, { source: 'scheduler' })
      expect(notices).toHaveLength(1)
      const n = notices[0]
      expect(n.userId).toBe('u1')
      expect(n.starterId).toBe(b.starterId)
      expect(n.starterName).toBe(b.name)
      expect(n.used).toBe(5)
      expect(n.limit).toBe(5)
      expect(n.exhausted).toBe(true)
      expect(n.planName).toBe('Seed')
      expect(n.topStarters.map((t) => [t.starterId, t.count])).toEqual([
        [a.starterId, 4],
        [b.starterId, 1],
      ])
    } finally {
      quota.setOnExhausted(null)
    }
  })

  it('un fallo del hook no rompe el rechazo', async () => {
    await subscribe('u1', 'plan_seed')
    quota.setOnExhausted(async () => {
      throw new Error('boom')
    })
    try {
      const starter = await makeStarter('u1')
      for (let i = 0; i < 5; i++) await ranExecution(starter.starterId, 'u1')
      const verdict = await quota.check(starter)
      expect(verdict.allowed).toBe(false)
    } finally {
      quota.setOnExhausted(null)
    }
  })
})

describe('live feed (onExecutionRecorded)', () => {
  it('se llama tras cada ejecución, también en los rechazos, y un fallo del hook no rompe la ejecución', async () => {
    await subscribe('u1', 'plan_seed')
    const seen: Array<{ starterId: string; ok: boolean; refused: boolean; source: string }> = []
    const runner = new AutomateRunner({
      db,
      model,
      boardService: {} as never,
      pubSubService: null,
      handleScheduledEvent: async () => ({ success: true }),
      actionBridgeManager: null,
      onExecutionRecorded: async (starter, result, ctx) => {
        seen.push({ starterId: starter.starterId, ok: result.ok, refused: result.refused === true, source: ctx.source })
        if (seen.length === 2) throw new Error('boom')
      },
    })
    runner.setCanExecute((starter) => quota.check(starter))
    const a = await makeStarter('u1')
    for (let i = 0; i < 6; i++) expect(await runner.executeAction(a, { source: 'scheduler' })).toBeTruthy()
    expect(seen).toHaveLength(6)
    expect(seen.slice(0, 5).every((e) => e.ok && !e.refused && e.source === 'scheduler')).toBe(true)
    expect(seen[5]).toMatchObject({ starterId: a.starterId, ok: false, refused: true })
  })
})
