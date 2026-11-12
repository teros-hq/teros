/**
 * Unit — AutomateRunner: ejecución de actions para los 3 triggers.
 *
 * Cubre:
 *   1. create-task: crea tarea con template {{payload.xxx}}.
 *   2. channel-event: inyecta mensaje con template y despierta al agente.
 *   3. start-flow: llama al engine con inputMapping aplicado.
 *   4. Scheduler tick: claim atómico, nextRunAt avanzado, cron inválido → disable.
 *   5. Event matching: wildcards, filtros, starters deshabilitados.
 *   6. Helpers puros: renderTemplate, getDotPath, topicMatches, filtersMatch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import {
  AutomateRunner,
  filtersMatch,
  getDotPath,
  renderTemplate,
  topicMatches,
} from '../../src/services/automate-runner'
import { AutomateModel } from '../../src/models/automate'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_runner_test_${Date.now()}`

const WS = 'work_runner_test'
const PROJECT = 'proj_runner_test'
const BOARD = 'board_runner_test'
const AGENT = 'agent_runner_test'
const CHANNEL = 'ch_runner_test'
const FLOW = 'flow_runner_test'

let client: MongoClient
let db: Db
let model: AutomateModel
let runner: AutomateRunner

// Spies
let createdTasks: Array<{ boardId: string; agentId: string; input: Record<string, unknown> }> = []
let broadcasts: Array<{ topic: string; event: Record<string, unknown> }> = []
let injectedEvents: Array<Record<string, unknown>> = []
let flowExecutions: Array<{ flowId: string; triggeredBy: string; input: unknown }> = []

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  model = new AutomateModel(db)
  await model.ensureIndexes()

  await db.collection('boards').insertOne({
    boardId: BOARD,
    projectId: PROJECT,
    columns: [{ columnId: 'col_todo', slug: 'todo', name: 'To Do', position: 0 }],
  })

  runner = new AutomateRunner({
    db,
    model,
    boardService: {
      getBoardByProject: async () => ({ boardId: BOARD }),
      createTask: async (boardId: string, agentId: string, input: Record<string, unknown>) => {
        createdTasks.push({ boardId, agentId, input })
        return { taskId: `task_${createdTasks.length}` }
      },
      getTask: async () => null,
      addProgressNote: async () => {},
    } as any,
    pubSubService: {
      broadcastToTopic: (topic: string, event: Record<string, unknown>) => {
        broadcasts.push({ topic, event })
      },
    },
    handleScheduledEvent: async (event) => {
      injectedEvents.push(event as unknown as Record<string, unknown>)
      return { success: true }
    },
    actionBridgeManager: {
      getEngine: () => ({
        startExecution: async (flowId: string, triggeredBy: string, input: unknown) => {
          flowExecutions.push({ flowId, triggeredBy, input })
          return { execution: { executionId: 'exec_1', status: 'running' } }
        },
      }),
    } as any,
  })
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  createdTasks = []
  broadcasts = []
  injectedEvents = []
  flowExecutions = []
  await db.collection('automate_starters').deleteMany({})
})

// ===========================================================================
// Helpers puros
// ===========================================================================

describe('helpers puros', () => {
  it('renderTemplate resuelve {{payload.xxx}} y dot-paths con arrays', () => {
    const payload = { title: 'Hola', issue: { number: 42 }, items: ['a', 'b'] }
    expect(renderTemplate('Nuevo: {{title}} #{{issue.number}}', payload)).toBe('Nuevo: Hola #42')
    expect(renderTemplate('Primer: {{items.0}}', payload)).toBe('Primer: a')
    expect(renderTemplate('Todo: {{payload}}', payload)).toBe(`Todo: ${JSON.stringify(payload)}`)
    expect(renderTemplate('Missing: {{nope}}', payload)).toBe('Missing: ')
  })

  it('getDotPath resuelve objetos y arrays', () => {
    expect(getDotPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1)
    expect(getDotPath({ arr: [{ x: 9 }] }, 'arr.0.x')).toBe(9)
    expect(getDotPath({ a: 1 }, 'a.b')).toBeUndefined()
    expect(getDotPath(null, 'a')).toBeUndefined()
  })

  it('topicMatches soporta exacto, * y wildcards', () => {
    expect(topicMatches('board.task_moved', 'board.task_moved')).toBe(true)
    expect(topicMatches('*', 'cualquier.cosaa')).toBe(true)
    expect(topicMatches('board.*', 'board.task_moved')).toBe(true)
    expect(topicMatches('board.task_*', 'board.task_moved')).toBe(true)
    expect(topicMatches('board.*', 'telegram.message')).toBe(false)
  })

  it('filtersMatch: OR entre objetos, AND dentro, vacío = match', () => {
    expect(filtersMatch(undefined, {})).toBe(true)
    expect(filtersMatch([], {})).toBe(true)
    expect(filtersMatch([{ a: 1 }, { b: 2 }], { b: 2 })).toBe(true)
    expect(filtersMatch([{ a: 1, b: 2 }], { a: 1 })).toBe(false)
    expect(filtersMatch([{ 'x.y': 5 }], { x: { y: 5 } })).toBe(true)
  })
})

// ===========================================================================
// Action: create-task
// ===========================================================================

describe('action create-task', () => {
  it('crea tarea con template y payload', async () => {
    const starter = await model.createStarter({
      name: 'GH issues',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'webhook', tokenHash: 'a'.repeat(64), callCount: 0 },
      action: {
        type: 'create-task',
        projectId: PROJECT,
        agentId: AGENT,
        targetColumnId: 'col_todo',
        titleTemplate: 'Issue #{{payload.number}}: {{payload.title}}',
        instructionsTemplate: 'Triage issue #{{payload.number}}',
        descriptionTemplate: '{{payload.title}}',
      },
    })

    const result = await runner.executeAction(starter, {
      source: 'webhook',
      payload: { number: 7, title: 'Bug grave' },
    })

    expect(result.ok).toBe(true)
    expect(result.taskId).toBeDefined()
    expect(createdTasks).toHaveLength(1)
    expect(createdTasks[0].boardId).toBe(BOARD)
    expect(createdTasks[0].input.title).toBe('Issue #7: Bug grave')
    expect(createdTasks[0].input.assignedAgentId).toBe(AGENT)
    expect(createdTasks[0].input.columnId).toBe('col_todo')
    // Board windows subscribed to the board topic get the new task in real time
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].topic).toBe(`board:${BOARD}`)
    expect(broadcasts[0].event.type).toBe('board_task_created')
    expect(broadcasts[0].event.boardId).toBe(BOARD)
    expect((broadcasts[0].event.task as { taskId: string }).taskId).toBe(result.taskId)
  })

  it('an empty title render is an execution error, never a fallback', async () => {
    const starter = await model.createStarter({
      name: 'Sin titulo',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'webhook', tokenHash: 'b'.repeat(64), callCount: 0 },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_todo', titleTemplate: '{{payload.title}}', instructionsTemplate: 'x' },
    })

    const result = await runner.executeAction(starter, { source: 'webhook', payload: { number: 1 } })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('EMPTY_TITLE')
    expect(createdTasks).toHaveLength(0)
  })

  it('the payload becomes the task input artifact (untyped for webhooks)', async () => {
    const starter = await model.createStarter({
      name: 'Input',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'webhook', tokenHash: 'e'.repeat(64), callCount: 0 },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_todo', titleTemplate: '{{title}}', instructionsTemplate: 'Procesa {{payload}}' },
    })
    await runner.executeAction(starter, { source: 'webhook', payload: { title: 'Lead', email: 'a@b.c' } })
    expect(createdTasks[0].input.input).toEqual({ schemaId: null, data: { title: 'Lead', email: 'a@b.c' } })
    expect(createdTasks[0].input.description).toBeUndefined()
    expect(createdTasks[0].input.instructions).toBe('Procesa {"title":"Lead","email":"a@b.c"}')
  })
})

// ===========================================================================
// Action: channel-event
// ===========================================================================

describe('action channel-event', () => {
  it('inyecta mensaje con template y wakeUpAgent', async () => {
    const starter = await model.createStarter({
      name: 'Alerta canal',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'x.y' },
      action: {
        type: 'channel-event',
        channelId: CHANNEL,
        agentId: AGENT,
        eventTemplate: 'Evento {{topic}}: {{payload.msg}}',
      },
    })

    const result = await runner.executeAction(starter, {
      source: 'event',
      topic: 'x.y',
      payload: { msg: 'hola' },
    })

    expect(result.ok).toBe(true)
    expect(injectedEvents).toHaveLength(1)
    const ev = injectedEvents[0] as any
    expect(ev.channelId).toBe(CHANNEL)
    expect(ev.message).toBe('Evento x.y: hola')
    expect(ev.wakeUpAgent).toBe(true)
    expect(ev.metadata.source).toBe('automate')
  })
})

// ===========================================================================
// Action: start-flow
// ===========================================================================

describe('action start-flow', () => {
  it('ejecuta el flow con inputMapping aplicado', async () => {
    const starter = await model.createStarter({
      name: 'Flow por webhook',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'webhook', tokenHash: 'c'.repeat(64), callCount: 0 },
      action: {
        type: 'start-flow',
        flowId: FLOW,
        projectId: PROJECT,
        inputMapping: { issueNumber: 'number', repo: 'repository.name' },
      },
    })

    const result = await runner.executeAction(starter, {
      source: 'webhook',
      payload: { number: 3, repository: { name: 'teros' } },
    })

    expect(result.ok).toBe(true)
    expect(result.executionId).toBe('exec_1')
    expect(flowExecutions).toHaveLength(1)
    expect(flowExecutions[0].flowId).toBe(FLOW)
    expect(flowExecutions[0].triggeredBy).toBe('webhook')
    expect(flowExecutions[0].input).toEqual({ issueNumber: 3, repo: 'teros' })
  })

  it('sin bridge → error controlado', async () => {
    const noBridgeRunner = new AutomateRunner({
      db,
      model,
      boardService: {} as any,
      handleScheduledEvent: async () => ({ success: true }),
      actionBridgeManager: null,
    })
    const starter = await model.createStarter({
      name: 'Flow sin bridge',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'a.b' },
      action: { type: 'start-flow', flowId: FLOW, projectId: PROJECT },
    })

    const result = await noBridgeRunner.executeAction(starter, { source: 'event', payload: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not available')
  })
})

// ===========================================================================
// Trigger: scheduler (tick)
// ===========================================================================

describe('trigger scheduler (tick)', () => {
  it('dispara starters vencidos y avanza nextRunAt (claim atómico)', async () => {
    const starter = await model.createStarter({
      name: 'Cada minuto',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: {
        type: 'scheduler',
        cronExpression: '* * * * *',
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        totalExecutions: 0,
      },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_todo', titleTemplate: 'Tarea {{payload.title || "sin titulo"}}', instructionsTemplate: 'Haz la tarea' },
    })

    await runner.runTick()

    expect(createdTasks).toHaveLength(1)
    const updated = await model.getStarterById(starter.starterId)
    expect(updated!.trigger).toMatchObject({ totalExecutions: 1 })
    expect((updated!.trigger as any).nextRunAt).toBeDefined()
    // nextRunAt avanzó al futuro
    expect(new Date((updated!.trigger as any).nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1000)
  })

  it('no dispara starters con nextRunAt en el futuro', async () => {
    await model.createStarter({
      name: 'Futuro',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: {
        type: 'scheduler',
        cronExpression: '0 0 1 1 *',
        nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_todo', titleTemplate: 'Tarea {{payload.title || "sin titulo"}}', instructionsTemplate: 'Haz la tarea' },
    })

    await runner.runTick()
    expect(createdTasks).toHaveLength(0)
  })

  it('starter sin nextRunAt → se programa en el primer tick, NO dispara', async () => {
    const starter = await model.createStarter({
      name: 'Recién importado',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'scheduler', cronExpression: '* * * * *' },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_todo', titleTemplate: 'Tarea {{payload.title || "sin titulo"}}', instructionsTemplate: 'Haz la tarea' },
    })

    await runner.runTick()

    expect(createdTasks).toHaveLength(0)
    const updated = await model.getStarterById(starter.starterId)
    const next = (updated!.trigger as any).nextRunAt as string
    expect(next).toBeDefined()
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now() - 1000)
    expect((updated!.trigger as any).totalExecutions ?? 0).toBe(0)
  })

  it('cron inválido → starter deshabilitado, tick no revienta', async () => {
    const starter = await model.createStarter({
      name: 'Cron roto',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'scheduler', cronExpression: '0 25 * * *' },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_todo', titleTemplate: 'Tarea {{payload.title || "sin titulo"}}', instructionsTemplate: 'Haz la tarea' },
    })

    await runner.runTick()

    const updated = await model.getStarterById(starter.starterId)
    expect(updated!.enabled).toBe(false)
    expect(createdTasks).toHaveLength(0)
  })
})

// ===========================================================================
// Trigger: event
// ===========================================================================

describe('trigger event', () => {
  it('dispara starters cuyo patrón matchea (wildcard) y filtros ok', async () => {
    await model.createStarter({
      name: 'Task a review',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: {
        type: 'event',
        eventPattern: 'board.task_*',
        filters: [{ toStatus: 'review' }],
      },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'A review: {{payload.taskTitle}}' },
    })
    await model.createStarter({
      name: 'Telegram',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'telegram.*' },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Aviso {{topic}} {{payload}}' },
    })

    const r1 = await runner.onEventDispatched({ topic: 'board.task_moved', payload: { workspaceId: WS, toStatus: 'review', taskTitle: 'T1' } })
    expect(r1).toEqual({ matched: 1, executed: 1 })
    expect(injectedEvents[0].message).toBe('A review: T1')

    // Filtro no matchea
    const r2 = await runner.onEventDispatched({ topic: 'board.task_moved', payload: { workspaceId: WS, toStatus: 'done' } })
    expect(r2).toEqual({ matched: 0, executed: 0 })
  })

  it('ignora starters deshabilitados', async () => {
    const starter = await model.createStarter({
      name: 'Apagado',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'a.b' },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Aviso {{topic}} {{payload}}' },
    })
    await model.setStarterEnabled(starter.starterId, false)

    const r = await runner.onEventDispatched({ topic: 'a.b', payload: { workspaceId: WS } })
    expect(r).toEqual({ matched: 0, executed: 0 })
  })

  it('solo casa starters del workspace del evento; sin workspace ni canal resoluble no dispara nada', async () => {
    await model.createStarter({
      name: 'Mío',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'telegram.*' },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Aviso {{topic}} {{payload}}' },
    })
    await db.collection('channels').insertOne({ channelId: 'ch_other_ws', workspaceId: 'work_other', agentId: AGENT })

    // Otro workspace → no casa aunque el topic coincida.
    expect(await runner.onEventDispatched({ topic: 'telegram.message.received', payload: { workspaceId: 'work_other' } }))
      .toEqual({ matched: 0, executed: 0 })
    // Sin workspaceId pero con channelId de otro workspace → se resuelve y no casa.
    expect(await runner.onEventDispatched({ topic: 'telegram.message.received', payload: { channelId: 'ch_other_ws' } }))
      .toEqual({ matched: 0, executed: 0 })
    // Sin nada que identifique el tenant → ignorado (fail closed).
    expect(await runner.onEventDispatched({ topic: 'telegram.message.received', payload: {} }))
      .toEqual({ matched: 0, executed: 0 })
    // Con el workspace correcto → dispara.
    expect(await runner.onEventDispatched({ topic: 'telegram.message.received', payload: { workspaceId: WS } }))
      .toEqual({ matched: 1, executed: 1 })
    await db.collection('channels').deleteMany({ channelId: 'ch_other_ws' })
  })
})

// ===========================================================================
// Trigger: once
// ===========================================================================

describe('trigger once', () => {
  it('dispara una vez cuando vence y se apaga solo', async () => {
    const starter = await model.createStarter({
      name: 'Recordatorio',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'once', at: new Date(Date.now() - 1000).toISOString(), nextRunAt: new Date(Date.now() - 1000).toISOString() },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Hora de revisar' },
    })

    await runner.runTick()
    expect(injectedEvents).toHaveLength(1)
    expect(injectedEvents[0].message).toBe('Hora de revisar')

    const after = await model.getStarterById(starter.starterId)
    expect(after!.enabled).toBe(false)
    expect((after!.trigger as any).firedAt).toBeDefined()
    expect((after!.trigger as any).totalExecutions).toBe(1)

    // Un segundo tick no lo vuelve a disparar.
    await runner.runTick()
    expect(injectedEvents).toHaveLength(1)
  })

  it('no dispara antes de su hora y se programa si llega sin nextRunAt', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString()
    const starter = await model.createStarter({
      name: 'Futuro',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'once', at },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Aviso {{topic}} {{payload}}' },
    })
    await runner.runTick()
    expect(injectedEvents).toHaveLength(0)
    const after = await model.getStarterById(starter.starterId)
    expect((after!.trigger as any).nextRunAt).toBe(at)
    expect(after!.enabled).toBe(true)
  })
})

// ===========================================================================
// Guards: billing gate + failure cap
// ===========================================================================

describe('guards', () => {
  it('el gate de billing bloquea la ejecución y la registra como fallo con motivo', async () => {
    const starter = await model.createStarter({
      name: 'Sin horas',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'x.y' },
      action: { type: 'channel-event', channelId: CHANNEL, agentId: AGENT, eventTemplate: 'Aviso {{topic}} {{payload}}' },
    })
    runner.setCanExecute(async () => ({ allowed: false, reason: 'billing-hours_exhausted' }))
    try {
      const result = await runner.executeAction(starter, { source: 'event', topic: 'x.y', payload: {} })
      expect(result.ok).toBe(false)
      expect(result.error).toBe('billing-hours_exhausted')
      expect(injectedEvents).toHaveLength(0)
      const exec = await db.collection('automate_executions').findOne({ starterId: starter.starterId })
      expect(exec!.ok).toBe(false)
      expect(exec!.error).toBe('billing-hours_exhausted')
    } finally {
      runner.setCanExecute(undefined)
    }
  })

  it('tras 5 fallos consecutivos el starter se desactiva; un éxito resetea el contador', async () => {
    const starter = await model.createStarter({
      name: 'Falla',
      createdBy: 'u1',
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'x.y' },
      // Proyecto sin board → create-task falla de forma controlada en cada ejecución.
      action: { type: 'create-task', projectId: 'proj_sin_board', agentId: AGENT, targetColumnId: '', titleTemplate: 'x', instructionsTemplate: 'y' },
    })
    // A refused gate counts as a failed execution.
    runner.setCanExecute(async () => ({ allowed: false, reason: 'billing-payment_due' }))
    try {
      for (let i = 0; i < 4; i++) {
        await runner.executeAction(starter, { source: 'event', payload: {} })
      }
      let s = await model.getStarterById(starter.starterId)
      expect(s!.enabled).toBe(true)
      expect(s!.consecutiveFailures).toBe(4)

      await runner.executeAction(starter, { source: 'event', payload: {} })
      s = await model.getStarterById(starter.starterId)
      expect(s!.enabled).toBe(false)
      expect(s!.consecutiveFailures).toBe(5)
    } finally {
      runner.setCanExecute(undefined)
    }
    let s = await model.getStarterById(starter.starterId)

    // Re-activar limpia el presupuesto de fallos.
    await model.setStarterEnabled(starter.starterId, true)
    s = await model.getStarterById(starter.starterId)
    expect(s!.consecutiveFailures).toBeUndefined()
    expect(s!.enabled).toBe(true)
  })
})
