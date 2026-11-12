/**
 * AutomateRunner — {{now.*}} template context.
 *
 * Verifies that create-task titles/instructions render the execution instant
 * in the trigger's timezone (scheduler/once) or UTC (event/webhook), and that
 * two executions at different hours produce different titles (the "Inbox Cero"
 * hourly-cycle use case).
 */
import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { AutomateRunner } from './automate-runner'
import type { BoardService } from './board-service'
import type { AutomateModel } from '../models/automate'
import type { AutomateStarter } from '../types/database-automate'

interface CreatedTask {
  title: string
  instructions: string
  description?: string
}

function makeStarter(overrides: Partial<AutomateStarter> = {}): AutomateStarter {
  return {
    starterId: 'starter_test',
    type: 'scheduler',
    name: 'test',
    workspaceId: 'ws_1',
    createdBy: 'user_1',
    createdAt: '2026-10-21T00:00:00.000Z',
    enabled: true,
    trigger: { type: 'scheduler', cronExpression: '0 * * * *', timezone: 'Europe/Madrid' },
    action: {
      type: 'create-task',
      projectId: 'proj_1',
      targetColumnId: 'col_1',
      agentId: 'agent_1',
      titleTemplate: '📬 Procesar inbox — ciclo ({{now.date}} {{now.time}})',
      instructionsTemplate: 'Process the inbox. Run started at {{now.time}} ({{now.weekday}}).',
      descriptionTemplate: 'cycle {{now.iso}}',
    },
    ...overrides,
  } as AutomateStarter
}

function makeRunner() {
  const created: CreatedTask[] = []
  const runner = new AutomateRunner({
    db: {} as Db,
    model: {
      recordExecution: async () => ({}),
      recordExecutionOutcome: async () => 0,
    } as unknown as AutomateModel,
    boardService: {
      getBoardByProject: async () => ({ boardId: 'board_1' }),
      createTask: async (_boardId: string, _agentId: string | undefined, data: { title: string; instructions: string; description?: string }) => {
        created.push({ title: data.title, instructions: data.instructions, description: data.description })
        return { taskId: 'task_1', title: data.title }
      },
    } as unknown as BoardService,
    handleScheduledEvent: async () => ({ success: true }),
    actionBridgeManager: null,
  })
  return { runner, created }
}

describe('AutomateRunner {{now.*}} context', () => {
  it('renders the title in the trigger timezone; two executions at different hours produce different titles', async () => {
    const { runner, created } = makeRunner()
    const starter = makeStarter()

    // 16:00Z = 18:00 in Madrid (CEST, summer)
    await runner.executeAction(starter, { source: 'scheduler', firedAt: '2026-10-21T16:00:00.000Z' })
    // 17:00Z = 19:00 in Madrid
    await runner.executeAction(starter, { source: 'scheduler', firedAt: '2026-10-21T17:00:00.000Z' })

    expect(created).toHaveLength(2)
    expect(created[0].title).toBe('📬 Procesar inbox — ciclo (2026-10-21 18:00)')
    expect(created[1].title).toBe('📬 Procesar inbox — ciclo (2026-10-21 19:00)')
    expect(created[0].title).not.toBe(created[1].title)
  })

  it('renders instructions and description with now.* in the trigger timezone', async () => {
    const { runner, created } = makeRunner()
    await runner.executeAction(makeStarter(), { source: 'scheduler', firedAt: '2026-10-21T16:00:00.000Z' })

    expect(created[0].instructions).toBe('Process the inbox. Run started at 18:00 (Wednesday).')
    expect(created[0].description).toBe('cycle 2026-10-21T16:00:00.000Z')
  })

  it('event triggers have no timezone → renders in UTC', async () => {
    const { runner, created } = makeRunner()
    const starter = makeStarter({
      type: 'event',
      trigger: { type: 'event', eventPattern: 'board.*' },
    } as Partial<AutomateStarter>)

    await runner.executeAction(starter, { source: 'event', topic: 'board.task_created', payload: {}, firedAt: '2026-10-21T16:00:00.000Z' })

    expect(created[0].title).toBe('📬 Procesar inbox — ciclo (2026-10-21 16:00)')
  })

  it('honors the once trigger timezone', async () => {
    const { runner, created } = makeRunner()
    const starter = makeStarter({
      type: 'once',
      trigger: { type: 'once', at: '2026-01-21T16:00:00.000Z', timezone: 'Europe/Madrid' },
    } as Partial<AutomateStarter>)

    // Winter: 16:00Z = 17:00 in Madrid (CET)
    await runner.executeAction(starter, { source: 'once', firedAt: '2026-01-21T16:00:00.000Z' })

    expect(created[0].title).toBe('📬 Procesar inbox — ciclo (2026-01-21 17:00)')
  })

  it('falls back to the execution moment when the context has no firedAt (webhook path)', async () => {
    const { runner, created } = makeRunner()
    const starter = makeStarter({
      type: 'webhook',
      trigger: { type: 'webhook' },
    } as Partial<AutomateStarter>)

    const before = Date.now()
    await runner.executeAction(starter, { source: 'webhook', payload: {} })
    const after = Date.now()

    const iso = (created[0].description ?? '').replace(/^cycle /, '')
    const ts = Date.parse(iso)
    expect(Number.isNaN(ts)).toBe(false)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
    // No timezone on webhook triggers → UTC date/time in the title
    expect(created[0].title).toMatch(/ciclo \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/)
  })
})
