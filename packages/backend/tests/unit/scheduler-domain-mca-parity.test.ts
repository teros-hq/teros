/**
 * Criterio 22 — paridad del dominio scheduler: WsRouter ↔ MCA (TER-483).
 *
 * El dominio está servido por DOS paths que NO comparten código:
 *   - WsRouter: `packages/backend/src/handlers/domains/scheduler/*`
 *   - MCA:      `mcas/mca.teros.scheduler/src/{tools,lib}/*`
 *
 * `_helpers.ts` del backend es un ESPEJO manual de `lib/*` del MCA ("if you
 * fix one, fix the other"). Estos tests importan AMBOS lados y verifican la
 * simetría real: mismo set de acciones, mismos shapes formateados, misma
 * validación (cron 5 campos, delay, channelId) y mismo gate write-time de
 * ownership del canal. Si un lado evoluciona sin el otro, esto se pone rojo.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { register } from '../../src/handlers/domains/scheduler'
import {
  CHANNEL_ID_REGEX,
  describeCronExpression,
  formatNextRun,
  formatRecurringTask,
  formatReminder,
  isValidCronExpression,
  parseDelayExpression,
} from '../../src/handlers/domains/scheduler/_helpers'
import { WsRouter } from '../../src/ws-framework/WsRouter'
import {
  describeCronExpression as mcaDescribeCronExpression,
  isValidCronExpression as mcaIsValidCronExpression,
} from '../../../../mcas/mca.teros.scheduler/src/lib/cron'
import {
  formatRecurringTask as mcaFormatRecurringTask,
  formatReminder as mcaFormatReminder,
} from '../../../../mcas/mca.teros.scheduler/src/lib/format'
import {
  formatNextRun as mcaFormatNextRun,
  parseDelayExpression as mcaParseDelayExpression,
} from '../../../../mcas/mca.teros.scheduler/src/lib/time'

const MCA_TOOLS_DIR = join(import.meta.dir, '../../../../mcas/mca.teros.scheduler/src/tools')
const MCA_SHARED_SRC = readFileSync(join(MCA_TOOLS_DIR, '_shared.ts'), 'utf8')
const BACKEND_DOMAIN_DIR = join(import.meta.dir, '../../src/handlers/domains/scheduler')

// ===========================================================================
// Set ↔ set: cada tool del MCA (menos health-check) tiene su acción WsRouter
// ===========================================================================

describe('criterio 22 — set de acciones', () => {
  it('acciones del WsRouter == tools del MCA (sin health-check)', () => {
    const router = new WsRouter()
    // SchedulerStore solo toca la DB en runtime; un stub de collection basta
    // para registrar. Si el register empezara a tocar la DB, esto fallaría.
    const dbStub = { collection: () => ({}) }
    // biome-ignore lint/suspicious/noExplicitAny: stub mínimo para register()
    register(router, { db: dbStub as any })
    const actions = router.listActions()

    const tools = readdirSync(MCA_TOOLS_DIR)
      .filter((f) => f.endsWith('.ts') && !['_shared.ts', 'index.ts', 'health-check.ts'].includes(f))
      .map((f) => `scheduler.${f.replace(/\.ts$/, '')}`)
      .sort()

    expect(actions).toEqual(tools)
  })
})

// ===========================================================================
// Shape mirror: misma row → mismo output formateado en ambos paths
// ===========================================================================

describe('criterio 22 — shapes formateados idénticos', () => {
  const TS_2030 = new Date('2030-01-01T10:00:00.000Z').getTime()

  it('formatReminder: output IDÉNTICO sobre la misma row', () => {
    const row = {
      id: 7,
      user_id: 'user_aaaaaaaaaaaaaaaa',
      channel_id: 'ch_aaaaaaaaaaaaaaaa',
      message: 'Pagar alquiler',
      scheduled_time: TS_2030,
      created_at: 1_780_000_000_000,
      status: 'pending' as const,
      timezone: 'Europe/Madrid',
    }
    expect(formatReminder(row, 'UTC')).toEqual(mcaFormatReminder(row, 'UTC'))
  })

  it('formatReminder: fallback de timezone cuando la row no la persiste', () => {
    const row = {
      id: 1,
      user_id: 'user_aaaaaaaaaaaaaaaa',
      channel_id: 'ch_aaaaaaaaaaaaaaaa',
      message: 'x',
      scheduled_time: TS_2030,
      created_at: 1_780_000_000_000,
      status: 'sent' as const,
    }
    const ours = formatReminder(row, 'Asia/Tokyo')
    expect(ours).toEqual(mcaFormatReminder(row, 'Asia/Tokyo'))
    expect(ours.timezone).toBe('Asia/Tokyo')
  })

  it('formatRecurringTask: output IDÉNTICO con y sin last_run', () => {
    const base = {
      id: 3,
      user_id: 'user_aaaaaaaaaaaaaaaa',
      channel_id: 'ch_aaaaaaaaaaaaaaaa',
      message: 'standup',
      cron_expression: '0 9 * * 1-5',
      timezone: 'Europe/Madrid',
      enabled: true,
      next_run: TS_2030,
      created_at: 1_780_000_000_000,
    }
    expect(formatRecurringTask(base)).toEqual(mcaFormatRecurringTask(base))
    const withLastRun = { ...base, last_run: 1_780_500_000_000 }
    expect(formatRecurringTask(withLastRun)).toEqual(mcaFormatRecurringTask(withLastRun))
  })

  it('formatRecurringTask: normalización legacy enabled=1 idéntica', () => {
    const row = {
      id: 1,
      user_id: 'u',
      channel_id: 'ch_aaaaaaaaaaaaaaaa',
      message: 'x',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      // biome-ignore lint/suspicious/noExplicitAny: shape legacy (SQLite 0/1)
      enabled: 1 as any,
      next_run: TS_2030,
      created_at: 1_780_000_000_000,
    }
    expect(formatRecurringTask(row).enabled).toBe(true)
    expect(formatRecurringTask(row)).toEqual(mcaFormatRecurringTask(row))
  })
})

// ===========================================================================
// Validación espejo: cron / delay / formatNextRun / channelId
// ===========================================================================

describe('criterio 22 — validación idéntica', () => {
  it('isValidCronExpression: mismo veredicto en ambos paths', () => {
    const cases = [
      '0 9 * * *',
      '*/15 * * * *',
      '0 10-22 * * 1-5',
      '*/30 * * * * *', // 6 campos (segundos) — el contrato es 5
      '@daily',
      'not a cron',
      '0 25 * * *', // hora fuera de rango
      '',
    ]
    for (const expr of cases) {
      expect({ expr, valid: isValidCronExpression(expr) }).toEqual({
        expr,
        valid: mcaIsValidCronExpression(expr),
      })
    }
  })

  it('describeCronExpression: misma descripción humana', () => {
    for (const expr of ['0 9 * * *', '0 9 * * 1-5', '*/15 * * * *', '0 0 1 * *', '30 14 * * 3']) {
      expect(describeCronExpression(expr)).toBe(mcaDescribeCronExpression(expr))
    }
  })

  it('parseDelayExpression: mismos ms y mismos rechazos', () => {
    for (const delay of ['45s', '30m', '2h', '1d', '90 minutes']) {
      expect({ delay, ms: parseDelayExpression(delay) }).toEqual({
        delay,
        ms: mcaParseDelayExpression(delay),
      })
    }
    expect(() => parseDelayExpression('banana')).toThrow()
    expect(() => mcaParseDelayExpression('banana')).toThrow()
  })

  it('formatNextRun: mismo texto humano con now fijo (todas las ramas)', () => {
    const NOW = new Date('2026-06-04T12:00:00.000Z').getTime()
    const offsets = [
      30_000, // <1 min
      5 * 60_000, // minutos
      3 * 3_600_000, // horas
      26 * 3_600_000, // tomorrow at HH:MM
      4 * 86_400_000, // in N days
      30 * 86_400_000, // formato absoluto
      -5 * 60_000, // pasado
    ]
    for (const offset of offsets) {
      const ts = NOW + offset
      expect({ offset, text: formatNextRun(ts, 'Europe/Madrid', NOW) }).toEqual({
        offset,
        text: mcaFormatNextRun(ts, 'Europe/Madrid', NOW),
      })
    }
  })

  it('CHANNEL_ID_REGEX: mismo regex que el MCA (_shared.ts)', () => {
    const m = MCA_SHARED_SRC.match(/CHANNEL_ID_REGEX = (\/[^;]+\/)/)
    expect(m).not.toBeNull()
    expect(`/${CHANNEL_ID_REGEX.source}/`).toBe(m?.[1])
  })
})

// ===========================================================================
// Gate write-time del canal: ambos paths validan shape + ownership en los
// DOS writes con channelId (schedule-reminder, create-recurring-task).
// Lint-as-test: impide que un path pierda el gate sin que esto se ponga rojo.
// ===========================================================================

describe('criterio 22 — gate de canal simétrico en los writes', () => {
  const backendHandlersSrc = readFileSync(join(BACKEND_DOMAIN_DIR, 'handlers.ts'), 'utf8')

  function backendHandlerBody(factoryName: string): string {
    const start = backendHandlersSrc.indexOf(`export function ${factoryName}(`)
    expect(start).toBeGreaterThan(-1)
    const next = backendHandlersSrc.indexOf('export function', start + 1)
    return backendHandlersSrc.slice(start, next === -1 ? undefined : next)
  }

  for (const [factory, mcaTool] of [
    ['createScheduleReminderHandler', 'schedule-reminder.ts'],
    ['createCreateRecurringTaskHandler', 'create-recurring-task.ts'],
  ] as const) {
    it(`${mcaTool.replace('.ts', '')}: shape + ownership en ambos paths`, () => {
      const backendBody = backendHandlerBody(factory)
      const mcaSrc = readFileSync(join(MCA_TOOLS_DIR, mcaTool), 'utf8')
      for (const src of [backendBody, mcaSrc]) {
        expect(src).toContain('assertValidChannelId(input.channelId)')
        expect(src).toMatch(/await assertChannelOwnership\(/)
      }
    })
  }
})
