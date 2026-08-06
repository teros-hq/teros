/**
 * Contract-boundary — handlers del dominio `scheduler` del WsRouter (TER-483).
 *
 * Cubre las 18 acciones `scheduler.*` registradas por
 * `handlers/domains/scheduler/index.ts` contra MongoDB REAL (mismo patrón que
 * scheduler-service-crossuser.test.ts): handler → store → Mongo, sin mocks del
 * boundary. Los handlers se obtienen del WsRouter tras `register()` para que
 * el wiring de producción (incluido el resolver `getChannelOwner` del index)
 * quede bajo test.
 *
 * Focos:
 *   1. Scoping per-usuario: ids son counters PER-USER (Alice y Bob tienen
 *      legítimamente el mismo id) — cada acción debe tocar SOLO la fila del
 *      ctx.userId (la clase de bug del incidente prod 2026-06-03).
 *   2. Authz write-time del canal (paridad criterio 22 con el MCA): shape
 *      `ch_<16hex>` + ownership estricto en schedule-reminder y
 *      create-recurring-task.
 *   3. Validación de params al boundary (Zod refines, límites, enums).
 *   4. Payload exacto (`toEqual`) de los shapes formateados.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { type Db, MongoClient } from 'mongodb'
import { register } from '../../src/handlers/domains/scheduler'
import { WsRouter } from '../../src/ws-framework/WsRouter'

// `bun test` carga `.env.test` → MONGODB_URI apunta al Mongo EFÍMERO de test
// (localhost:27019, `scripts/test-integration.sh` / DEV_GUIDE §puertos).
// serverSelectionTimeoutMS corto para fallar con mensaje claro si el
// contenedor no está levantado, en vez de colgar el hook 5s sin output.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_scheduler_domain_test_${Date.now()}`

const USER_ALICE = 'user_aaaaaaaaaaaaaaaa'
const USER_BOB = 'user_bbbbbbbbbbbbbbbb'
const CH_ALICE = 'ch_aaaaaaaaaaaaaaaa'
const CH_ALICE_2 = 'ch_aaaaaaaaaaaaaaa2'
const CH_BOB = 'ch_bbbbbbbbbbbbbbbb'
const CH_GHOST = 'ch_0123456789abcdef' // shape válido, no existe en channels

// Tiempos fijos futuros (válidos hasta 2030) para asserts deterministas.
const ISO_2030 = '2030-01-01T10:00:00.000Z'
const TS_2030 = new Date(ISO_2030).getTime()

let client: MongoClient
let db: Db
type Handler = (ctx: WsHandlerContext, raw: unknown) => Promise<unknown>
let handlers: Map<string, Handler>

function h(action: string): Handler {
  const handler = handlers.get(action)
  if (!handler) throw new Error(`handler not registered: ${action}`)
  return handler
}

function ctx(userId: string): WsHandlerContext {
  return { userId, sessionId: 'sess_test', ip: '127.0.0.1' }
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  // Canales: Alice posee 2, Bob 1. Ownership estricto por channel.userId.
  await db.collection('channels').insertMany([
    { channelId: CH_ALICE, userId: USER_ALICE },
    { channelId: CH_ALICE_2, userId: USER_ALICE },
    { channelId: CH_BOB, userId: USER_BOB },
  ])
  const router = new WsRouter()
  register(router, { db })
  // biome-ignore lint/suspicious/noExplicitAny: acceso al Map privado — patrón del repo
  handlers = (router as any).handlers
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  for (const col of [
    'scheduler_reminders',
    'scheduler_recurring_tasks',
    'scheduler_executions',
    'scheduler_counters',
  ]) {
    await db.collection(col).deleteMany({})
  }
})

// Helpers de siembra vía los propios handlers (ejercitan el path real).
async function seedReminder(userId: string, channelId: string, message: string, time = ISO_2030) {
  // biome-ignore lint/suspicious/noExplicitAny: resultado dinámico del handler
  return (await h('scheduler.schedule-reminder')(ctx(userId), { time, message, channelId })) as any
}

async function seedTask(userId: string, channelId: string, message: string, cron = '0 9 * * *') {
  // biome-ignore lint/suspicious/noExplicitAny: resultado dinámico del handler
  return (await h('scheduler.create-recurring-task')(ctx(userId), {
    cronExpression: cron,
    message,
    channelId,
  })) as any
}

// ===========================================================================
// register() — wiring
// ===========================================================================

describe('register()', () => {
  it('registra exactamente las 18 acciones scheduler.*', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'scheduler.bulk-cancel',
      'scheduler.cancel-reminder',
      'scheduler.create-recurring-task',
      'scheduler.delete-recurring-task',
      'scheduler.disable-recurring-task',
      'scheduler.enable-recurring-task',
      'scheduler.get-recurring-task',
      'scheduler.get-reminder',
      'scheduler.get-stats',
      'scheduler.list-executions',
      'scheduler.list-recurring-tasks',
      'scheduler.list-reminders',
      'scheduler.list-upcoming',
      'scheduler.parse-time-expression',
      'scheduler.schedule-reminder',
      'scheduler.snooze-reminder',
      'scheduler.update-recurring-task',
      'scheduler.update-reminder',
    ])
  })
})

// ===========================================================================
// scheduler.parse-time-expression
// ===========================================================================

describe('scheduler.parse-time-expression', () => {
  it('ISO → kind iso con payload exacto', async () => {
    const result = await h('scheduler.parse-time-expression')(ctx(USER_ALICE), {
      expression: ISO_2030,
      timezone: 'Europe/Madrid',
    })
    expect(result).toEqual({
      kind: 'iso',
      expression: ISO_2030,
      timezone: 'Europe/Madrid',
      confidence: 'high',
      parsed: {
        timestamp: TS_2030,
        iso: ISO_2030,
        // Madrid = UTC+1 en enero. El separador date-time ("at" vs ",") lo decide
        // la versión de ICU del runtime (Node en prod/local → "at"; bun/alpine en CI
        // → ","), así que afirmamos la info (Jan 1 + 11:00), no el literal frágil.
        humanReadable: expect.stringMatching(/^Jan 1.{1,4}11:00$/),
      },
    })
  })

  it('natural con reference fija → timestamp exacto reference+2h', async () => {
    const ref = '2027-03-10T10:00:00.000Z'
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.parse-time-expression')(ctx(USER_ALICE), {
      expression: 'in 2 hours',
      timezone: 'Europe/Madrid',
      reference: ref,
    })) as any
    expect(result.kind).toBe('natural')
    expect(result.parsed.timestamp).toBe(new Date(ref).getTime() + 2 * 3_600_000)
    expect(result.confidence).toBe('high')
    expect(result.detectedText).toBe('in 2 hours')
    expect(result.locale).toBe('en')
  })

  it('cron 5 campos → kind cron con 5 ocurrencias monotónicas', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.parse-time-expression')(ctx(USER_ALICE), {
      expression: '0 9 * * *',
    })) as any
    expect(result.kind).toBe('cron')
    expect(result.description).toBe('Every day at 9:00')
    expect(result.nextOccurrences).toHaveLength(5)
    for (let i = 1; i < 5; i++) {
      expect(result.nextOccurrences[i].timestamp).toBeGreaterThan(
        result.nextOccurrences[i - 1].timestamp,
      )
    }
    expect(result.nextOccurrences[0]).toEqual({
      timestamp: expect.any(Number),
      iso: expect.any(String),
      humanReadable: expect.any(String),
    })
  })

  it('previewCount acota las ocurrencias', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.parse-time-expression')(ctx(USER_ALICE), {
      expression: '*/15 * * * *',
      previewCount: 2,
    })) as any
    expect(result.nextOccurrences).toHaveLength(2)
  })

  it('cron de 6 campos NO se trata como cron (contrato 5 campos)', async () => {
    await expect(
      h('scheduler.parse-time-expression')(ctx(USER_ALICE), { expression: '*/30 * * * * *' }),
    ).rejects.toMatchObject({ code: 'INVALID_TIME_EXPRESSION' })
  })

  it('timezone inválida → INVALID_TIMEZONE', async () => {
    await expect(
      h('scheduler.parse-time-expression')(ctx(USER_ALICE), {
        expression: 'in 1 hour',
        timezone: 'Mars/Olympus',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TIMEZONE' })
  })

  it('expression vacía → INVALID_INPUT', async () => {
    await expect(
      h('scheduler.parse-time-expression')(ctx(USER_ALICE), { expression: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('previewCount fuera de rango (0, 21) → INVALID_INPUT', async () => {
    for (const previewCount of [0, 21]) {
      await expect(
        h('scheduler.parse-time-expression')(ctx(USER_ALICE), {
          expression: '0 9 * * *',
          previewCount,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
  })

  it('texto no parseable → INVALID_TIME_EXPRESSION con sugerencia', async () => {
    await expect(
      h('scheduler.parse-time-expression')(ctx(USER_ALICE), { expression: 'gibberish xyz' }),
    ).rejects.toMatchObject({
      code: 'INVALID_TIME_EXPRESSION',
      message: expect.stringContaining('Try:'),
    })
  })
})

// ===========================================================================
// scheduler.get-stats
// ===========================================================================

describe('scheduler.get-stats', () => {
  it('sin datos → payload exacto con nulls', async () => {
    const result = await h('scheduler.get-stats')(ctx(USER_ALICE), { timezone: 'UTC' })
    expect(result).toEqual({
      active: { reminders: 0, recurringTasks: 0 },
      nextScheduledAt: null,
      nextScheduledIso: null,
      nextScheduledHumanReadable: null,
      timezone: 'UTC',
    })
  })

  it('cuenta SOLO lo del usuario del contexto', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'A1')
    await seedReminder(USER_ALICE, CH_ALICE, 'A2')
    await seedTask(USER_ALICE, CH_ALICE, 'T1')
    await seedReminder(USER_BOB, CH_BOB, 'B1')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const alice = (await h('scheduler.get-stats')(ctx(USER_ALICE), {})) as any
    expect(alice.active).toEqual({ reminders: 2, recurringTasks: 1 })
    // nextScheduledAt = min(reminder 2030, task próxima 09:00) → la task
    expect(alice.nextScheduledAt).toBeLessThan(TS_2030)
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const bob = (await h('scheduler.get-stats')(ctx(USER_BOB), {})) as any
    expect(bob.active).toEqual({ reminders: 1, recurringTasks: 0 })
  })

  it('reminder cancelado no cuenta como activo', async () => {
    const created = await seedReminder(USER_ALICE, CH_ALICE, 'A1')
    await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: created.reminder.id })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const stats = (await h('scheduler.get-stats')(ctx(USER_ALICE), {})) as any
    expect(stats.active.reminders).toBe(0)
  })
})

// ===========================================================================
// scheduler.schedule-reminder
// ===========================================================================

describe('scheduler.schedule-reminder', () => {
  it('happy path → payload exacto y persiste user_id correcto', async () => {
    const result = await seedReminder(USER_ALICE, CH_ALICE, 'Pagar alquiler')
    expect(result).toEqual({
      action: 'created',
      reminder: {
        id: 1,
        message: 'Pagar alquiler',
        channelId: CH_ALICE,
        status: 'pending',
        nextRunAt: TS_2030,
        nextRunIso: ISO_2030,
        humanReadable: expect.stringMatching(/^Jan 1.{1,4}11:00$/), // separador "at"/"," varía por ICU (Node vs bun/alpine)
        timezone: 'Europe/Madrid', // default env resuelto
        createdAt: expect.any(String),
      },
    })
    const row = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_ALICE })
    expect(row?.channel_id).toBe(CH_ALICE)
    expect(row?.status).toBe('pending')
  })

  it('counter per-user: Alice y Bob obtienen ambos id=1', async () => {
    const a = await seedReminder(USER_ALICE, CH_ALICE, 'de Alice')
    const b = await seedReminder(USER_BOB, CH_BOB, 'de Bob')
    expect(a.reminder.id).toBe(1)
    expect(b.reminder.id).toBe(1)
  })

  it('ids secuenciales para el mismo user', async () => {
    const r1 = await seedReminder(USER_ALICE, CH_ALICE, 'uno')
    const r2 = await seedReminder(USER_ALICE, CH_ALICE, 'dos')
    expect([r1.reminder.id, r2.reminder.id]).toEqual([1, 2])
  })

  it('canal de OTRO usuario → FORBIDDEN y NO persiste nada', async () => {
    await expect(seedReminder(USER_ALICE, CH_BOB, 'intruso')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('does not belong'),
    })
    expect(await db.collection('scheduler_reminders').countDocuments({})).toBe(0)
  })

  it('canal inexistente (shape válido) → FORBIDDEN', async () => {
    await expect(seedReminder(USER_ALICE, CH_GHOST, 'fantasma')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('channelId con shape inválido → INVALID_INPUT antes de tocar DB', async () => {
    for (const channelId of ['general', 'ch_XYZ', 'ch_aaaaaaaaaaaaaaa', `${CH_ALICE}f`]) {
      await expect(seedReminder(USER_ALICE, channelId, 'x')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    }
  })

  it('el gate de canal gana a la validación de tiempo (orden paridad MCA)', async () => {
    await expect(
      h('scheduler.schedule-reminder')(ctx(USER_ALICE), {
        time: '2001-01-01T00:00:00.000Z', // pasado
        message: 'x',
        channelId: CH_BOB, // ajeno
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('message vacío o >4000 chars → INVALID_INPUT', async () => {
    await expect(seedReminder(USER_ALICE, CH_ALICE, '')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(seedReminder(USER_ALICE, CH_ALICE, 'x'.repeat(4001))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('time en pasado → PAST_TIME_NOT_ALLOWED; con allowPast se crea', async () => {
    await expect(
      h('scheduler.schedule-reminder')(ctx(USER_ALICE), {
        time: '2001-01-01T00:00:00.000Z',
        message: 'x',
        channelId: CH_ALICE,
      }),
    ).rejects.toMatchObject({ code: 'PAST_TIME_NOT_ALLOWED' })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const ok = (await h('scheduler.schedule-reminder')(ctx(USER_ALICE), {
      time: '2001-01-01T00:00:00.000Z',
      message: 'x',
      channelId: CH_ALICE,
      allowPast: true,
    })) as any
    expect(ok.action).toBe('created')
  })

  it('timezone inválida → INVALID_TIMEZONE', async () => {
    await expect(
      h('scheduler.schedule-reminder')(ctx(USER_ALICE), {
        time: ISO_2030,
        message: 'x',
        channelId: CH_ALICE,
        timezone: 'Not/AZone',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TIMEZONE' })
  })

  it('ctx sin userId → NO_USER_CONTEXT', async () => {
    await expect(
      h('scheduler.schedule-reminder')(ctx(''), { time: ISO_2030, message: 'x', channelId: CH_ALICE }),
    ).rejects.toMatchObject({ code: 'NO_USER_CONTEXT' })
  })
})

// ===========================================================================
// scheduler.list-reminders
// ===========================================================================

describe('scheduler.list-reminders', () => {
  it('scoping: cada user ve SOLO los suyos', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'A1')
    await seedReminder(USER_ALICE, CH_ALICE_2, 'A2')
    await seedReminder(USER_BOB, CH_BOB, 'B1')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const alice = (await h('scheduler.list-reminders')(ctx(USER_ALICE), {})) as any
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const bob = (await h('scheduler.list-reminders')(ctx(USER_BOB), {})) as any
    expect(alice.items.map((r: { message: string }) => r.message).sort()).toEqual(['A1', 'A2'])
    expect(bob.items.map((r: { message: string }) => r.message)).toEqual(['B1'])
  })

  it('filtra por status y channelId', async () => {
    const r1 = await seedReminder(USER_ALICE, CH_ALICE, 'A1')
    await seedReminder(USER_ALICE, CH_ALICE_2, 'A2')
    await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: r1.reminder.id })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const cancelled = (await h('scheduler.list-reminders')(ctx(USER_ALICE), {
      status: 'cancelled',
    })) as any
    expect(cancelled.items.map((r: { message: string }) => r.message)).toEqual(['A1'])
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const byChannel = (await h('scheduler.list-reminders')(ctx(USER_ALICE), {
      channelId: CH_ALICE_2,
    })) as any
    expect(byChannel.items.map((r: { message: string }) => r.message)).toEqual(['A2'])
  })

  it('pagina con cursor estable (scheduled_time, id)', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'uno', '2030-01-01T10:00:00.000Z')
    await seedReminder(USER_ALICE, CH_ALICE, 'dos', '2030-01-02T10:00:00.000Z')
    await seedReminder(USER_ALICE, CH_ALICE, 'tres', '2030-01-03T10:00:00.000Z')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page1 = (await h('scheduler.list-reminders')(ctx(USER_ALICE), { limit: 2 })) as any
    expect(page1.items.map((r: { message: string }) => r.message)).toEqual(['uno', 'dos'])
    expect(page1.nextCursor).toBeDefined()
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page2 = (await h('scheduler.list-reminders')(ctx(USER_ALICE), {
      limit: 2,
      cursor: page1.nextCursor,
    })) as any
    expect(page2.items.map((r: { message: string }) => r.message)).toEqual(['tres'])
    expect(page2.nextCursor).toBeUndefined()
  })

  it('limit fuera de rango (0, 201) → INVALID_INPUT', async () => {
    for (const limit of [0, 201]) {
      await expect(h('scheduler.list-reminders')(ctx(USER_ALICE), { limit })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    }
  })

  it('cursor malformado se IGNORA (página completa, no vacía) (gap P6)', async () => {
    // decodeCursor devuelve null ante basura → el filtro no aplica cursor.
    // Sin el guard, Number(undefined)=NaN filtraría a lista vacía en silencio.
    await seedReminder(USER_ALICE, CH_ALICE, 'uno')
    await seedReminder(USER_ALICE, CH_ALICE, 'dos')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page = (await h('scheduler.list-reminders')(ctx(USER_ALICE), { cursor: 'garbage' })) as any
    expect(page.items).toHaveLength(2)
  })

  it('resultado con EXACTAMENTE limit items → sin nextCursor espurio', async () => {
    // Gap S15 del hunt: `items.length >= limit` emitiría un cursor hacia una
    // página vacía cuando el total coincide con el límite.
    await seedReminder(USER_ALICE, CH_ALICE, 'uno', '2030-01-01T10:00:00.000Z')
    await seedReminder(USER_ALICE, CH_ALICE, 'dos', '2030-01-02T10:00:00.000Z')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page = (await h('scheduler.list-reminders')(ctx(USER_ALICE), { limit: 2 })) as any
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeUndefined()
  })
})

// ===========================================================================
// scheduler.list-upcoming
// ===========================================================================

describe('scheduler.list-upcoming', () => {
  it('both (default): reminders dentro de la ventana + recurring con next_run dentro', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString()
    await seedReminder(USER_ALICE, CH_ALICE, 'pronto', soon)
    await seedReminder(USER_ALICE, CH_ALICE, 'lejos', ISO_2030) // fuera de 7 días
    await seedTask(USER_ALICE, CH_ALICE, 'diaria') // 09:00 → next_run < 7 días
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.list-upcoming')(ctx(USER_ALICE), {})) as any
    expect(result.windowDays).toBe(7)
    expect(result.windowEndIso).toBe(new Date(result.windowEndAt).toISOString())
    expect(result.reminders.map((r: { message: string }) => r.message)).toEqual(['pronto'])
    expect(result.recurringTasks.map((t: { message: string }) => t.message)).toEqual(['diaria'])
  })

  it('include=reminders omite recurring; include=recurring omite reminders', async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString()
    await seedReminder(USER_ALICE, CH_ALICE, 'r', soon)
    await seedTask(USER_ALICE, CH_ALICE, 't')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const onlyR = (await h('scheduler.list-upcoming')(ctx(USER_ALICE), { include: 'reminders' })) as any
    expect(onlyR.reminders).toHaveLength(1)
    expect(onlyR.recurringTasks).toEqual([])
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const onlyT = (await h('scheduler.list-upcoming')(ctx(USER_ALICE), { include: 'recurring' })) as any
    expect(onlyT.reminders).toEqual([])
    expect(onlyT.recurringTasks).toHaveLength(1)
  })

  it('recurring con next_run fuera del horizonte queda filtrada', async () => {
    // Tarea anual: 1 de enero a las 00:00 — next_run > 7 días casi todo el año.
    // Para determinismo: forzamos next_run lejano editando la fila tras crear.
    await seedTask(USER_ALICE, CH_ALICE, 'anual')
    await db
      .collection('scheduler_recurring_tasks')
      .updateMany({ user_id: USER_ALICE }, { $set: { next_run: TS_2030 } })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.list-upcoming')(ctx(USER_ALICE), {})) as any
    expect(result.recurringTasks).toEqual([])
  })

  it('days fuera de rango (0, 91) → INVALID_INPUT', async () => {
    for (const days of [0, 91]) {
      await expect(h('scheduler.list-upcoming')(ctx(USER_ALICE), { days })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    }
  })
})

// ===========================================================================
// scheduler.get-reminder
// ===========================================================================

describe('scheduler.get-reminder', () => {
  it('cross-user: con el MISMO id numérico cada user recibe EL SUYO', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'de Alice')
    await seedReminder(USER_BOB, CH_BOB, 'de Bob')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const a = (await h('scheduler.get-reminder')(ctx(USER_ALICE), { reminderId: 1 })) as any
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const b = (await h('scheduler.get-reminder')(ctx(USER_BOB), { reminderId: 1 })) as any
    expect(a.reminder.message).toBe('de Alice')
    expect(b.reminder.message).toBe('de Bob')
  })

  it('id ajeno/inexistente → NOT_FOUND', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'de Alice')
    await expect(h('scheduler.get-reminder')(ctx(USER_BOB), { reminderId: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('reminderId no positivo → INVALID_INPUT', async () => {
    await expect(h('scheduler.get-reminder')(ctx(USER_ALICE), { reminderId: 0 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })
})

// ===========================================================================
// scheduler.update-reminder
// ===========================================================================

describe('scheduler.update-reminder', () => {
  it('sin time ni message → INVALID_INPUT (refine)', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    await expect(
      h('scheduler.update-reminder')(ctx(USER_ALICE), { reminderId: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('actualiza message → changedFields exacto y persiste', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.update-reminder')(ctx(USER_ALICE), {
      reminderId: 1,
      message: 'editado',
    })) as any
    expect(result.action).toBe('updated')
    expect(result.changedFields).toEqual(['message'])
    expect(result.reminder.message).toBe('editado')
    expect(result.reminder.nextRunAt).toBe(TS_2030) // time intacto
  })

  it('actualiza time → changedFields [scheduled_time] y nextRunAt nuevo', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    const newIso = '2030-06-01T08:00:00.000Z'
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.update-reminder')(ctx(USER_ALICE), {
      reminderId: 1,
      time: newIso,
    })) as any
    expect(result.changedFields).toEqual(['scheduled_time'])
    expect(result.reminder.nextRunAt).toBe(new Date(newIso).getTime())
  })

  it('cross-user: Bob NO puede tocar el reminder de Alice (mismo id)', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'de Alice')
    await expect(
      h('scheduler.update-reminder')(ctx(USER_BOB), { reminderId: 1, message: 'hackeado' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const row = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_ALICE })
    expect(row?.message).toBe('de Alice')
  })

  it('reminder cancelado → ALREADY_TERMINAL con estado en el mensaje', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 1 })
    await expect(
      h('scheduler.update-reminder')(ctx(USER_ALICE), { reminderId: 1, message: 'tarde' }),
    ).rejects.toMatchObject({
      code: 'ALREADY_TERMINAL',
      message: expect.stringContaining('cancelled'),
    })
  })
})

// ===========================================================================
// scheduler.snooze-reminder
// ===========================================================================

describe('scheduler.snooze-reminder', () => {
  it('happy: delayMs exacto y scheduled_time desplazado', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    const before = Date.now()
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.snooze-reminder')(ctx(USER_ALICE), {
      reminderId: 1,
      delay: '30m',
    })) as any
    expect(result.action).toBe('snoozed')
    expect(result.delayMs).toBe(1_800_000)
    expect(result.reminder.nextRunAt).toBeGreaterThanOrEqual(before + 1_800_000)
    expect(result.reminder.nextRunAt).toBeLessThanOrEqual(Date.now() + 1_800_000)
  })

  it('delay no parseable → INVALID_INPUT', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    await expect(
      h('scheduler.snooze-reminder')(ctx(USER_ALICE), { reminderId: 1, delay: 'banana' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('terminal → ALREADY_TERMINAL; inexistente → NOT_FOUND', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 1 })
    await expect(
      h('scheduler.snooze-reminder')(ctx(USER_ALICE), { reminderId: 1, delay: '5m' }),
    ).rejects.toMatchObject({ code: 'ALREADY_TERMINAL' })
    await expect(
      h('scheduler.snooze-reminder')(ctx(USER_ALICE), { reminderId: 99, delay: '5m' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ===========================================================================
// scheduler.cancel-reminder
// ===========================================================================

describe('scheduler.cancel-reminder', () => {
  it('happy → action cancelled y persiste el estado', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 1 })) as any
    expect(result.action).toBe('cancelled')
    expect(result.reminder.status).toBe('cancelled')
  })

  it('cancelar dos veces → noop con reason', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'orig')
    await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 1 })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const again = (await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 1 })) as any
    expect(again.action).toBe('noop')
    expect(again.reason).toBe('Already cancelled.')
  })

  it('cross-user: cancela el SUYO, el del otro user (mismo id) queda pending', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'de Alice')
    await seedReminder(USER_BOB, CH_BOB, 'de Bob')
    await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 1 })
    const bobRow = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_BOB })
    expect(bobRow?.status).toBe('pending')
  })

  it('inexistente → NOT_FOUND', async () => {
    await expect(
      h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 7 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ===========================================================================
// scheduler.bulk-cancel
// ===========================================================================

describe('scheduler.bulk-cancel', () => {
  it('sin ningún filtro → INVALID_INPUT (refine)', async () => {
    await expect(h('scheduler.bulk-cancel')(ctx(USER_ALICE), {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('por ids: cancela SOLO los del user — el id homónimo de Bob queda intacto', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'A1')
    await seedReminder(USER_ALICE, CH_ALICE, 'A2')
    await seedReminder(USER_BOB, CH_BOB, 'B1')
    const result = await h('scheduler.bulk-cancel')(ctx(USER_ALICE), { ids: [1, 2] })
    expect(result).toEqual({
      action: 'bulk-cancelled',
      cancelledCount: 2,
      cancelledIds: [1, 2],
      timezone: 'Europe/Madrid',
    })
    const bobRow = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_BOB })
    expect(bobRow?.status).toBe('pending')
  })

  it('por ids: cancela SOLO los ids pedidos, no todo lo pending (gap H10)', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'A1')
    await seedReminder(USER_ALICE, CH_ALICE, 'A2')
    await seedReminder(USER_ALICE, CH_ALICE, 'A3')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.bulk-cancel')(ctx(USER_ALICE), { ids: [1, 3] })) as any
    expect(result.cancelledIds).toEqual([1, 3])
    const a2 = await db.collection('scheduler_reminders').findOne({ id: 2, user_id: USER_ALICE })
    expect(a2?.status).toBe('pending')
  })

  it('por channelId: solo los reminders de ese canal', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'A1')
    await seedReminder(USER_ALICE, CH_ALICE_2, 'A2')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.bulk-cancel')(ctx(USER_ALICE), { channelId: CH_ALICE })) as any
    expect(result.cancelledCount).toBe(1)
    const a2 = await db
      .collection('scheduler_reminders')
      .findOne({ user_id: USER_ALICE, channel_id: CH_ALICE_2 })
    expect(a2?.status).toBe('pending')
  })

  it('before acepta epoch number, numeric string e ISO', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'temprano', '2030-01-01T10:00:00.000Z')
    await seedReminder(USER_ALICE, CH_ALICE, 'tarde', '2030-06-01T10:00:00.000Z')
    const cutoff = new Date('2030-03-01T00:00:00.000Z')
    for (const before of [cutoff.getTime(), String(cutoff.getTime()), cutoff.toISOString()]) {
      // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
      const result = (await h('scheduler.bulk-cancel')(ctx(USER_ALICE), { before })) as any
      expect(result.cancelledIds).toEqual([1])
      // restaurar para la siguiente vuelta del loop
      await db
        .collection('scheduler_reminders')
        .updateMany({ user_id: USER_ALICE }, { $set: { status: 'pending' } })
    }
  })

  it('before no parseable → INVALID_INPUT', async () => {
    await expect(
      h('scheduler.bulk-cancel')(ctx(USER_ALICE), { before: 'banana' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

// ===========================================================================
// scheduler.create-recurring-task
// ===========================================================================

describe('scheduler.create-recurring-task', () => {
  it('happy path → payload exacto con next_run futuro', async () => {
    const before = Date.now()
    const result = await seedTask(USER_ALICE, CH_ALICE, 'standup diario')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const task = (result as any).task
    expect((result as { action: string }).action).toBe('created')
    expect(task).toEqual({
      id: 1,
      message: 'standup diario',
      channelId: CH_ALICE,
      cronExpression: '0 9 * * *',
      cronDescription: 'Every day at 9:00',
      enabled: true,
      timezone: 'Europe/Madrid',
      nextRunAt: expect.any(Number),
      nextRunIso: expect.any(String),
      humanReadable: expect.any(String),
      lastRunAt: undefined,
      lastRunIso: undefined,
      createdAt: expect.any(String),
    })
    expect(task.nextRunAt).toBeGreaterThan(before)
  })

  it('counter de tasks independiente del de reminders (ambos id=1)', async () => {
    const r = await seedReminder(USER_ALICE, CH_ALICE, 'reminder')
    const t = await seedTask(USER_ALICE, CH_ALICE, 'task')
    expect(r.reminder.id).toBe(1)
    expect(t.task.id).toBe(1)
  })

  it('cron de 6 campos o basura → INVALID_CRON', async () => {
    for (const cron of ['*/30 * * * * *', '@daily', 'not a cron', '0 25 * * *']) {
      await expect(seedTask(USER_ALICE, CH_ALICE, 'x', cron)).rejects.toMatchObject({
        code: 'INVALID_CRON',
      })
    }
  })

  it('canal de OTRO usuario → FORBIDDEN y NO persiste nada', async () => {
    await expect(seedTask(USER_ALICE, CH_BOB, 'intruso')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(await db.collection('scheduler_recurring_tasks').countDocuments({})).toBe(0)
  })

  it('cron sintácticamente válido SIN ocurrencia futura (30 feb) → INVALID_CRON', async () => {
    await expect(seedTask(USER_ALICE, CH_ALICE, 'imposible', '0 0 30 2 *')).rejects.toMatchObject({
      code: 'INVALID_CRON',
      message: expect.stringContaining('no future run'),
    })
  })

  it('channelId con shape inválido → INVALID_INPUT', async () => {
    await expect(seedTask(USER_ALICE, 'general', 'x')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })
})

// ===========================================================================
// scheduler.list-recurring-tasks
// ===========================================================================

describe('scheduler.list-recurring-tasks', () => {
  it('scoping per-user + filtro enabled', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'A1')
    await seedTask(USER_ALICE, CH_ALICE, 'A2')
    await seedTask(USER_BOB, CH_BOB, 'B1')
    await h('scheduler.disable-recurring-task')(ctx(USER_ALICE), { taskId: 2 })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const all = (await h('scheduler.list-recurring-tasks')(ctx(USER_ALICE), {})) as any
    expect(all.items.map((t: { message: string }) => t.message).sort()).toEqual(['A1', 'A2'])
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const enabled = (await h('scheduler.list-recurring-tasks')(ctx(USER_ALICE), {
      enabled: true,
    })) as any
    expect(enabled.items.map((t: { message: string }) => t.message)).toEqual(['A1'])
  })

  it('pagina con cursor (next_run, id)', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'uno')
    await seedTask(USER_ALICE, CH_ALICE, 'dos')
    await seedTask(USER_ALICE, CH_ALICE, 'tres')
    // Mismo cron → mismo next_run; el desempate del cursor es por id.
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page1 = (await h('scheduler.list-recurring-tasks')(ctx(USER_ALICE), { limit: 2 })) as any
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBeDefined()
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page2 = (await h('scheduler.list-recurring-tasks')(ctx(USER_ALICE), {
      limit: 2,
      cursor: page1.nextCursor,
    })) as any
    expect(page2.items).toHaveLength(1)
    expect(page2.nextCursor).toBeUndefined()
    const ids = [...page1.items, ...page2.items].map((t: { id: number }) => t.id)
    expect(ids).toEqual([1, 2, 3])
  })
})

// ===========================================================================
// scheduler.get-recurring-task / update / enable / disable / delete
// ===========================================================================

describe('scheduler.get-recurring-task', () => {
  it('cross-user: mismo id → cada uno la suya; ajena → NOT_FOUND', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const a = (await h('scheduler.get-recurring-task')(ctx(USER_ALICE), { taskId: 1 })) as any
    expect(a.task.message).toBe('de Alice')
    await expect(
      h('scheduler.get-recurring-task')(ctx(USER_BOB), { taskId: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('scheduler.update-recurring-task', () => {
  it('sin ningún campo → INVALID_INPUT (refine)', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'orig')
    await expect(
      h('scheduler.update-recurring-task')(ctx(USER_ALICE), { taskId: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('cambiar cron recomputa next_run → changedFields exacto', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'orig')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.update-recurring-task')(ctx(USER_ALICE), {
      taskId: 1,
      cronExpression: '0 18 * * 5',
    })) as any
    expect(result.action).toBe('updated')
    expect(result.changedFields).toEqual(['cron_expression', 'next_run'])
    expect(result.task.cronExpression).toBe('0 18 * * 5')
  })

  it('cambiar solo message NO recomputa next_run', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'orig')
    const rowBefore = await db
      .collection('scheduler_recurring_tasks')
      .findOne({ id: 1, user_id: USER_ALICE })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.update-recurring-task')(ctx(USER_ALICE), {
      taskId: 1,
      message: 'editado',
    })) as any
    expect(result.changedFields).toEqual(['message'])
    expect(result.task.nextRunAt).toBe(rowBefore?.next_run)
  })

  it('cambiar timezone recomputa next_run', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'orig')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.update-recurring-task')(ctx(USER_ALICE), {
      taskId: 1,
      timezone: 'Asia/Tokyo',
    })) as any
    expect(result.changedFields).toEqual(['timezone', 'next_run'])
    expect(result.task.timezone).toBe('Asia/Tokyo')
  })

  it('cron inválido → INVALID_CRON y la task queda intacta', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'orig')
    await expect(
      h('scheduler.update-recurring-task')(ctx(USER_ALICE), { taskId: 1, cronExpression: '@daily' }),
    ).rejects.toMatchObject({ code: 'INVALID_CRON' })
    const row = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_ALICE })
    expect(row?.cron_expression).toBe('0 9 * * *')
  })

  it('cross-user → NOT_FOUND sin tocar la fila ajena', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    await expect(
      h('scheduler.update-recurring-task')(ctx(USER_BOB), { taskId: 1, message: 'hackeado' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const row = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_ALICE })
    expect(row?.message).toBe('de Alice')
  })
})

describe('scheduler.enable/disable-recurring-task', () => {
  it('disable → enabled false sin recomputar next_run; enable recomputa', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'orig')
    const before = await db
      .collection('scheduler_recurring_tasks')
      .findOne({ id: 1, user_id: USER_ALICE })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const off = (await h('scheduler.disable-recurring-task')(ctx(USER_ALICE), { taskId: 1 })) as any
    expect(off.action).toBe('disabled')
    expect(off.task.enabled).toBe(false)
    expect(off.task.nextRunAt).toBe(before?.next_run)
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const on = (await h('scheduler.enable-recurring-task')(ctx(USER_ALICE), { taskId: 1 })) as any
    expect(on.action).toBe('enabled')
    expect(on.task.enabled).toBe(true)
    expect(on.task.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('enable recomputa un next_run PASADO a futuro (gap H9)', async () => {
    // Contrato: re-habilitar una task dormida no debe dispararla al instante
    // con su next_run viejo — enable SIEMPRE recomputa desde el cron.
    await seedTask(USER_ALICE, CH_ALICE, 'dormida')
    await h('scheduler.disable-recurring-task')(ctx(USER_ALICE), { taskId: 1 })
    await db
      .collection('scheduler_recurring_tasks')
      .updateOne({ id: 1, user_id: USER_ALICE }, { $set: { next_run: 1_000_000 } })
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const on = (await h('scheduler.enable-recurring-task')(ctx(USER_ALICE), { taskId: 1 })) as any
    expect(on.task.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('enable de una task ya enabled → noop', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'orig')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.enable-recurring-task')(ctx(USER_ALICE), { taskId: 1 })) as any
    expect(result.action).toBe('noop')
  })

  it('cross-user → NOT_FOUND y la task ajena conserva su enabled', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    await expect(
      h('scheduler.disable-recurring-task')(ctx(USER_BOB), { taskId: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const row = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_ALICE })
    expect(row?.enabled).toBe(true)
  })
})

describe('scheduler.delete-recurring-task', () => {
  it('borra la del user y deja intacta la homónima del otro', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    await seedTask(USER_BOB, CH_BOB, 'de Bob')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const result = (await h('scheduler.delete-recurring-task')(ctx(USER_ALICE), { taskId: 1 })) as any
    expect(result.action).toBe('deleted')
    expect(result.task.message).toBe('de Alice')
    const gone = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_ALICE })
    expect(gone).toBeNull()
    const bob = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_BOB })
    expect(bob?.message).toBe('de Bob')
  })

  it('inexistente → NOT_FOUND', async () => {
    await expect(
      h('scheduler.delete-recurring-task')(ctx(USER_ALICE), { taskId: 9 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ===========================================================================
// Scoping con VÍCTIMA PRIMERO — lección del incidente prod 2026-06-03: un
// write sin user_id matchea el PRIMER doc en orden natural, así que si el
// actor inserta primero, el bug queda enmascarado (el write acierta por
// accidente). Estos tests insertan la fila del OTRO usuario antes que la del
// actor; destapados por survivor hunt (S3/S9/S11: cancel, update-recurring,
// delete-recurring sin user_id sobrevivían a la suite con seed actor-primero).
// ===========================================================================

describe('scoping per-user — víctima insertada primero', () => {
  it('cancel-reminder: cancela el del actor, no el primero en orden natural', async () => {
    await seedReminder(USER_BOB, CH_BOB, 'víctima') // Bob PRIMERO (id=1)
    await seedReminder(USER_ALICE, CH_ALICE, 'del actor') // Alice id=1
    await h('scheduler.cancel-reminder')(ctx(USER_ALICE), { reminderId: 1 })
    const bob = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_BOB })
    const alice = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_ALICE })
    expect(bob?.status).toBe('pending')
    expect(alice?.status).toBe('cancelled')
  })

  it('update-reminder: actualiza el del actor, no el de la víctima', async () => {
    await seedReminder(USER_ALICE, CH_ALICE, 'víctima') // Alice PRIMERO (id=1)
    await seedReminder(USER_BOB, CH_BOB, 'del actor') // Bob id=1
    await h('scheduler.update-reminder')(ctx(USER_BOB), { reminderId: 1, message: 'editado' })
    const alice = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_ALICE })
    const bob = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER_BOB })
    expect(alice?.message).toBe('víctima')
    expect(bob?.message).toBe('editado')
  })

  it('update-recurring-task: actualiza la del actor, no la de la víctima', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'víctima') // Alice PRIMERO (id=1)
    await seedTask(USER_BOB, CH_BOB, 'del actor') // Bob id=1
    await h('scheduler.update-recurring-task')(ctx(USER_BOB), { taskId: 1, message: 'editada' })
    const alice = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_ALICE })
    const bob = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_BOB })
    expect(alice?.message).toBe('víctima')
    expect(bob?.message).toBe('editada')
  })

  it('delete-recurring-task: borra la del actor, no la de la víctima', async () => {
    await seedTask(USER_BOB, CH_BOB, 'víctima') // Bob PRIMERO (id=1)
    await seedTask(USER_ALICE, CH_ALICE, 'del actor') // Alice id=1
    await h('scheduler.delete-recurring-task')(ctx(USER_ALICE), { taskId: 1 })
    const bob = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_BOB })
    const alice = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER_ALICE })
    expect(bob?.message).toBe('víctima')
    expect(alice).toBeNull()
  })
})

// ===========================================================================
// scheduler.list-executions
// ===========================================================================

describe('scheduler.list-executions', () => {
  async function seedExecutions(userId: string, taskId: number, ranAts: number[]) {
    await db.collection('scheduler_executions').insertMany(
      ranAts.map((ran_at) => ({ user_id: userId, task_id: taskId, ran_at, status: 'success' })),
    )
  }

  it('gate: task de OTRO user → NOT_FOUND aunque existan executions', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    await seedExecutions(USER_ALICE, 1, [1000])
    await expect(
      h('scheduler.list-executions')(ctx(USER_BOB), { taskId: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lista en orden ran_at desc con shape exacto y filtra las del otro user', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    await seedTask(USER_BOB, CH_BOB, 'de Bob')
    await seedExecutions(USER_ALICE, 1, [1_000, 3_000, 2_000])
    await seedExecutions(USER_BOB, 1, [9_000]) // mismo task_id, otro user
    const result = await h('scheduler.list-executions')(ctx(USER_ALICE), { taskId: 1 })
    expect(result).toEqual({
      taskId: 1,
      items: [
        { taskId: 1, ranAt: 3_000, ranAtIso: new Date(3_000).toISOString(), status: 'success', error: undefined },
        { taskId: 1, ranAt: 2_000, ranAtIso: new Date(2_000).toISOString(), status: 'success', error: undefined },
        { taskId: 1, ranAt: 1_000, ranAtIso: new Date(1_000).toISOString(), status: 'success', error: undefined },
      ],
      nextCursor: undefined,
    })
  })

  it('EXACTAMENTE limit executions → sin nextCursor espurio (gap S21)', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    await seedExecutions(USER_ALICE, 1, [1_000, 2_000])
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page = (await h('scheduler.list-executions')(ctx(USER_ALICE), { taskId: 1, limit: 2 })) as any
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeUndefined()
  })

  it('pagina por cursor ran_at', async () => {
    await seedTask(USER_ALICE, CH_ALICE, 'de Alice')
    await seedExecutions(USER_ALICE, 1, [1_000, 2_000, 3_000])
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page1 = (await h('scheduler.list-executions')(ctx(USER_ALICE), { taskId: 1, limit: 2 })) as any
    expect(page1.items.map((e: { ranAt: number }) => e.ranAt)).toEqual([3_000, 2_000])
    expect(page1.nextCursor).toBeDefined()
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const page2 = (await h('scheduler.list-executions')(ctx(USER_ALICE), {
      taskId: 1,
      limit: 2,
      cursor: page1.nextCursor,
    })) as any
    expect(page2.items.map((e: { ranAt: number }) => e.ranAt)).toEqual([1_000])
    expect(page2.nextCursor).toBeUndefined()
  })
})
