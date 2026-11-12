/**
 * Contract-boundary — handlers del dominio `automate` del WsRouter (modelo v2).
 *
 * Cubre las acciones `automate.*` registradas por
 * `handlers/domains/automate/index.ts` contra MongoDB REAL. Los handlers se
 * obtienen del WsRouter tras `register()` para que el wiring de producción
 * quede bajo test.
 *
 * Focos:
 *   1. create-starter genérico: 3 triggers × 3 actions, validación, URL webhook,
 *      scoping por workspace de los targets, nextRunAt inicial del scheduler.
 *   2. update-starter genérico (patch de name/trigger/action) conservando el
 *      estado del trigger y devolviendo URL al pasar a webhook.
 *   3. test-webhook: ejecuta la action vía runner + dedupe por discriminator.
 *   4. Regeneración de URL y listado de llamadas webhook.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { type Db, MongoClient } from 'mongodb'
import { register } from '../../src/handlers/domains/automate'
import { WsRouter } from '../../src/ws-framework/WsRouter'
import { WorkspaceService } from '../../src/services/workspace-service'
import { AutomateModel } from '../../src/models/automate'
import { seedBillingPlans } from '../../src/models/billing'
import { AutomateRunner } from '../../src/services/automate-runner'
import { config } from '../../src/config'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_domain_test_${Date.now()}`
const TEST_API_BASE_URL = config.share.baseUrl

const USER_ALICE = 'user_aaaaaaaaaaaaaaaa'
const WORKSPACE_A = 'work_aaaaaaaaaaaaaaaa'
const PROJECT_A = 'proj_aaaaaaaaaaaaaaaa'
const BOARD_A = 'board_aaaaaaaaaaaaaaaa'
const AGENT_A = 'agent_aaaaaaaaaaaaaaaa'
const CH_A = 'ch_aaaaaaaaaaaaaaaa'
const FLOW_A = 'flow_aaaaaaaaaaaaaaaa'
const WORKSPACE_B = 'work_bbbbbbbbbbbbbbbb'
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbb'
const AGENT_B = 'agent_bbbbbbbbbbbbbbbb'
const CH_B = 'ch_bbbbbbbbbbbbbbbb'

let client: MongoClient
let db: Db
let workspaceService: WorkspaceService
let model: AutomateModel
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

  workspaceService = new WorkspaceService(db)
  model = new AutomateModel(db)
  await model.ensureIndexes()

  await db.collection('workspaces').insertOne({
    workspaceId: WORKSPACE_A,
    name: 'Workspace A',
    ownerId: USER_ALICE,
    status: 'active',
    members: [{ userId: USER_ALICE, role: 'owner' }],
  })
  await db.collection('projects').insertOne({
    projectId: PROJECT_A,
    workspaceId: WORKSPACE_A,
    name: 'Project A',
    status: 'active',
    boardId: BOARD_A,
  })
  await db.collection('boards').insertOne({
    boardId: BOARD_A,
    projectId: PROJECT_A,
    columns: [
      { columnId: 'col_backlog', slug: 'backlog', name: 'Backlog', position: 0 },
      { columnId: 'col_todo', slug: 'todo', name: 'To Do', position: 1 },
      { columnId: 'col_done', slug: 'done', name: 'Done', position: 2 },
    ],
  })
  await db.collection('agents').insertOne({
    agentId: AGENT_A,
    name: 'Agent A',
    status: 'active',
    workspaceId: WORKSPACE_A,
  })
  await db.collection('channels').insertOne({
    channelId: CH_A,
    // Real shape: the conversation title lives in metadata.name.
    metadata: { name: 'Channel A' },
    userId: USER_ALICE,
    agentId: AGENT_A,
  })
  await db.collection('flows').insertOne({
    flowId: FLOW_A,
    workspaceId: WORKSPACE_A,
    name: 'Flow A',
    status: 'active',
    nodes: [],
  })
  // Another tenant: its targets exist but must never be reachable from A.
  await db.collection('projects').insertOne({ projectId: PROJECT_B, workspaceId: WORKSPACE_B, name: 'Project B', status: 'active' })
  await db.collection('boards').insertOne({ boardId: 'board_b', projectId: PROJECT_B, columns: [{ columnId: 'col_b', slug: 'todo', name: 'To Do', position: 0 }] })
  await db.collection('agents').insertOne({ agentId: AGENT_B, name: 'Agent B', status: 'active', workspaceId: WORKSPACE_B })
  await db.collection('channels').insertOne({ channelId: CH_B, name: 'Channel B', workspaceId: WORKSPACE_B, agentId: AGENT_B })

  const router = new WsRouter()
  register(router, { db, workspaceService, runner: null })
  // biome-ignore lint/suspicious/noExplicitAny: acceso al Map privado — patrón del repo
  handlers = (router as any).handlers
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  for (const col of [
    'automate_starters',
    'automate_webhook_calls',
    'automate_executions',
    'scheduler_recurring_tasks',
    'scheduler_executions',
  ]) {
    await db.collection(col).deleteMany({})
  }
})

// ===========================================================================
// register() — wiring
// ===========================================================================

describe('register()', () => {
  it('registra las acciones automate.* del modelo v2', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'automate.create-starter',
      'automate.delete',
      'automate.get',
      'automate.list',
      'automate.list-calls',
      'automate.list-executions',
      'automate.list-flows',
      'automate.parse-schedule', // v1.4.4 NL/cron preview
      'automate.quota',
      'automate.regenerate-url',
      'automate.set-enabled',
      'automate.sync-flow-triggers',
      'automate.test-webhook',
      'automate.update-starter',
    ])
  })
})

// ===========================================================================
// automate.create-starter — 3 triggers × 3 actions
// ===========================================================================

describe('automate.create-starter', () => {
  it('scheduler + create-task: crea starter con cron validado', async () => {
    const result = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Cada mañana',
      trigger: { type: 'scheduler', cronExpression: '0 9 * * 1-5' },
      action: { type: 'create-task', projectId: PROJECT_A, agentId: AGENT_A, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' },
    })) as any

    expect(result.starter.type).toBe('scheduler')
    expect(result.starter.trigger).toMatchObject({ type: 'scheduler', cronExpression: '0 9 * * 1-5', totalExecutions: 0 })
    // Scheduled from the start: a fresh starter waits for its cron slot
    // instead of firing on the runner's next tick.
    expect(new Date(result.starter.trigger.nextRunAt).getTime()).toBeGreaterThan(Date.now())
    expect(result.starter.action).toMatchObject({ type: 'create-task', projectId: PROJECT_A, agentId: AGENT_A, targetColumnId: 'col_todo' })
    expect(result.url).toBeUndefined()
  })

  it('scheduler: acepta timezone IANA y rechaza una inválida', async () => {
    const ok = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Madrid',
      trigger: { type: 'scheduler', cronExpression: '0 9 * * *', timezone: 'Europe/Madrid' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    expect(ok.starter.trigger.timezone).toBe('Europe/Madrid')

    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'Marte',
        trigger: { type: 'scheduler', cronExpression: '0 9 * * *', timezone: 'Mars/Olympus' },
        action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
      }),
    ).rejects.toThrow('timezone')
  })

  it('rechaza targets de otro workspace (project, agent, channel)', async () => {
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'Proyecto ajeno',
        trigger: { type: 'event', eventPattern: 'x.y' },
        action: { type: 'create-task', projectId: PROJECT_B, agentId: AGENT_A, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' },
      }),
    ).rejects.toThrow('Project not found in workspace')
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'Agente ajeno',
        trigger: { type: 'event', eventPattern: 'x.y' },
        action: { type: 'create-task', projectId: PROJECT_A, agentId: AGENT_B, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' },
      }),
    ).rejects.toThrow('Agent not found in workspace')
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'Canal ajeno',
        trigger: { type: 'event', eventPattern: 'x.y' },
        action: { type: 'channel-event', channelId: CH_B, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
      }),
    ).rejects.toThrow('Channel not found in workspace')
  })

  it('webhook + channel-event: genera token y devuelve URL', async () => {
    const result = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Lead → canal',
      trigger: { type: 'webhook' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Nuevo: {{title}}' },
    })) as any

    expect(result.starter.type).toBe('webhook')
    expect(result.starter.trigger.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.starter.action).toMatchObject({ type: 'channel-event', channelId: CH_A })
    expect(result.url).toMatch(new RegExp(`^${TEST_API_BASE_URL}/api/v1/webhooks/[a-f0-9]{64}$`))
  })

  it('event + start-flow: valida patrón y flow', async () => {
    const result = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Task movida → flow',
      trigger: { type: 'event', eventPattern: 'board.task_*', filters: [{ status: 'review' }] },
      action: { type: 'start-flow', flowId: FLOW_A, projectId: PROJECT_A, inputMapping: { taskId: 'taskId' } },
    })) as any

    expect(result.starter.type).toBe('event')
    expect(result.starter.trigger).toMatchObject({ type: 'event', eventPattern: 'board.task_*' })
    expect(result.starter.action).toMatchObject({ type: 'start-flow', flowId: FLOW_A })
  })

  it('rechaza cron inválido', async () => {
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'Bad cron',
        trigger: { type: 'scheduler', cronExpression: '99 99 * * *' },
        action: { type: 'create-task', projectId: PROJECT_A, agentId: AGENT_A, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' },
      }),
    ).rejects.toThrow('Invalid cron')
  })

  it('rechaza action con proyecto inexistente', async () => {
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'Bad project',
        trigger: { type: 'event', eventPattern: 'x.y' },
        action: { type: 'create-task', projectId: 'proj_nooo', agentId: AGENT_A },
      }),
    ).rejects.toThrow('Project not found')
  })

  it('once: normaliza `at` a ISO, lo usa como nextRunAt y rechaza fechas pasadas', async () => {
    const at = new Date(Date.now() + 600_000)
    const ok = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Recordatorio',
      trigger: { type: 'once', at: at.toISOString().replace('.000Z', 'Z') },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    expect(ok.starter.type).toBe('once')
    expect(ok.starter.trigger.at).toBe(at.toISOString())
    expect(ok.starter.trigger.nextRunAt).toBe(at.toISOString())

    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'Pasado',
        trigger: { type: 'once', at: '2020-01-01T00:00:00.000Z' },
        action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
      }),
    ).rejects.toThrow('in the past')
  })

  it('idempotencyKey: un segundo create con la misma clave devuelve el mismo starter', async () => {
    const body = {
      workspaceId: WORKSPACE_A,
      name: 'Idempotente',
      trigger: { type: 'event', eventPattern: 'a.b' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
      idempotencyKey: 'agent-run-42',
    }
    const first = (await h('automate.create-starter')(ctx(USER_ALICE), body)) as any
    const second = (await h('automate.create-starter')(ctx(USER_ALICE), { ...body, name: 'Otro nombre' })) as any
    expect(second.starter.starterId).toBe(first.starter.starterId)
    expect(second.existing).toBe(true)
    expect(await db.collection('automate_starters').countDocuments({ workspaceId: WORKSPACE_A })).toBe(1)
  })

  it('registra createdByAgentId cuando el contexto trae un actor agente', async () => {
    const result = (await h('automate.create-starter')(
      { ...ctx(USER_ALICE), actor: { kind: 'agent', agentId: AGENT_A, workspaceId: WORKSPACE_A } },
      {
        workspaceId: WORKSPACE_A,
        name: 'Creado por agente',
        trigger: { type: 'event', eventPattern: 'a.b' },
        action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
      },
    )) as any
    expect(result.starter.createdBy).toBe(USER_ALICE)
    expect(result.starter.createdByAgentId).toBe(AGENT_A)
  })

  it('webhook: el cliente no elige el token — siempre lo genera el servidor', async () => {
    const result = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Token propio',
      trigger: { type: 'webhook', token: 'mi-token', tokenHash: 'deadbeef' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    expect(result.starter.trigger.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.starter.trigger.tokenHash).not.toBe('deadbeef')
    expect(result.url).toMatch(/\/api\/v1\/webhooks\/[a-f0-9]{64}$/)
  })
})

// ===========================================================================
// automate.update-starter — patch genérico
// ===========================================================================

describe('automate.update-starter', () => {
  it('actualiza name y action de un starter', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Original',
      trigger: { type: 'event', eventPattern: 'a.b' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    const starterId = created.starter.starterId

    const result = (await h('automate.update-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      starterId,
      name: 'Editado',
      action: { type: 'start-flow', flowId: FLOW_A, projectId: PROJECT_A },
    })) as any

    expect(result.starter.name).toBe('Editado')
    expect(result.starter.action).toMatchObject({ type: 'start-flow', flowId: FLOW_A })
  })

  it('webhook: conserva el token si el trigger no lo reenvía', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Wh',
      trigger: { type: 'webhook' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    const starterId = created.starter.starterId
    const originalHash = created.starter.trigger.tokenHash

    const result = (await h('automate.update-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      starterId,
      name: 'Wh editado',
      trigger: { type: 'webhook' },
    })) as any

    expect(result.starter.trigger.tokenHash).toBe(originalHash)
    expect(result.url).toBeUndefined()
  })

  it('scheduler: conserva stats y nextRunAt si el cron no cambia; recalcula si cambia', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Sched',
      trigger: { type: 'scheduler', cronExpression: '0 9 * * *' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    const starterId = created.starter.starterId
    await db.collection('automate_starters').updateOne(
      { starterId },
      { $set: { 'trigger.totalExecutions': 7, 'trigger.lastExecutionAt': '2026-10-01T09:00:00.000Z' } },
    )
    const firstNext = created.starter.trigger.nextRunAt

    const same = (await h('automate.update-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      starterId,
      trigger: { type: 'scheduler', cronExpression: '0 9 * * *' },
    })) as any
    expect(same.starter.trigger).toMatchObject({ totalExecutions: 7, lastExecutionAt: '2026-10-01T09:00:00.000Z', nextRunAt: firstNext })

    const changed = (await h('automate.update-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      starterId,
      trigger: { type: 'scheduler', cronExpression: '0 10 * * *' },
    })) as any
    expect(changed.starter.trigger.totalExecutions).toBe(7)
    expect(changed.starter.trigger.nextRunAt).not.toBe(firstNext)
  })

  it('cambiar el trigger sincroniza el type raíz y al pasar a webhook devuelve URL', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Evento',
      trigger: { type: 'event', eventPattern: 'a.b' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    const starterId = created.starter.starterId

    const result = (await h('automate.update-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      starterId,
      trigger: { type: 'webhook' },
    })) as any
    expect(result.starter.type).toBe('webhook')
    expect(result.starter.trigger.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.url).toMatch(/\/api\/v1\/webhooks\/[a-f0-9]{64}$/)

    // The webhook route can now find it by hash and regenerate-url accepts it.
    const byHash = await model.getStarterByTokenHash(result.starter.trigger.tokenHash)
    expect(byHash?.starterId).toBe(starterId)
  })

  it('rechaza un starterId de otro workspace', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Mío',
      trigger: { type: 'event', eventPattern: 'a.b' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    await expect(
      h('automate.update-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_B,
        starterId: created.starter.starterId,
        name: 'Robado',
      }),
    ).rejects.toThrow('does not belong')
  })
})

// ===========================================================================
// automate.test-webhook — ejecuta la action vía runner
// ===========================================================================

describe('automate.test-webhook', () => {
  it('ejecuta create-task vía runner y registra la llamada', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Webhook de test',
      trigger: { type: 'webhook' },
      action: { type: 'create-task', projectId: PROJECT_A, agentId: AGENT_A, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' },
    })) as any
    const starterId = created.starter.starterId

    const runner = new AutomateRunner({
      db,
      model,
      boardService: { getBoardByProject: async () => ({ boardId: BOARD_A }), createTask: async (_b: string, _a: string, input: any) => {
        const taskId = `task_${Date.now().toString(36)}`
        await db.collection('tasks').insertOne({ taskId, boardId: BOARD_A, title: input.title, columnId: input.columnId, tags: input.tags, progressNotes: [] })
        return { taskId }
      }, getTask: async (id: string) => db.collection('tasks').findOne({ taskId: id }), addProgressNote: async () => {} } as any,
      handleScheduledEvent: async () => ({ success: true }),
      actionBridgeManager: null,
    })

    const router2 = new WsRouter()
    register(router2, { db, workspaceService, runner })
    // biome-ignore lint/suspicious/noExplicitAny: acceso al Map privado
    const handlers2: Map<string, Handler> = (router2 as any).handlers

    const result = (await handlers2.get('automate.test-webhook')!(ctx(USER_ALICE), {
      starterId,
      payload: { title: 'Tarea desde test', discriminator: 'disc-1' },
    })) as any

    expect(result.taskId).toBeDefined()
    expect(result.outcome).toBe('created')

    const task = await db.collection('tasks').findOne({ taskId: result.taskId })
    expect(task!.title).toBe('Tarea desde test')

    const call = await db.collection('automate_webhook_calls').findOne({ starterId })
    expect(call).not.toBeNull()
    expect(call!.createdTask).toBe(true)

    const starter = await db.collection('automate_starters').findOne({ starterId })
    expect(starter!.trigger.callCount).toBe(1)

    // Same discriminator again → note on the existing task, and the execution
    // audit log still counts it (grid stats).
    const again = (await handlers2.get('automate.test-webhook')!(ctx(USER_ALICE), {
      starterId,
      payload: { title: 'Repetida', discriminator: 'disc-1' },
    })) as any
    expect(again.outcome).toBe('updated')
    expect(again.taskId).toBe(result.taskId)
    const executions = await db.collection('automate_executions').countDocuments({ starterId })
    expect(executions).toBe(2)
  })
})

// ===========================================================================
// automate.regenerate-url / list-calls
// ===========================================================================

describe('automate.regenerate-url', () => {
  it('rota el token y devuelve una nueva URL', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Webhook a rotar',
      trigger: { type: 'webhook' },
      action: { type: 'create-task', projectId: PROJECT_A, agentId: AGENT_A, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' },
    })) as any
    const starterId = created.starter.starterId
    const oldTokenHash = created.starter.trigger.tokenHash

    const result = (await h('automate.regenerate-url')(ctx(USER_ALICE), { starterId })) as any

    expect(result.url).toMatch(new RegExp(`^${TEST_API_BASE_URL}/api/v1/webhooks/[a-f0-9]{64}$`))

    const updated = await db.collection('automate_starters').findOne({ starterId })
    expect(updated!.trigger.tokenHash).not.toBe(oldTokenHash)
  })
})

describe('automate.list / get / list-executions', () => {
  it('list filtra por trigger, action, status y search, y pagina con cursor', async () => {
    const mk = (name: string, trigger: any, action: any) =>
      h('automate.create-starter')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A, name, trigger, action })
    await mk('Alpha cron', { type: 'scheduler', cronExpression: '0 9 * * *' }, { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' })
    await mk('Beta hook', { type: 'webhook' }, { type: 'create-task', projectId: PROJECT_A, agentId: AGENT_A, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' })
    const gamma = (await mk('Gamma event', { type: 'event', eventPattern: 'a.*' }, { type: 'start-flow', flowId: FLOW_A, projectId: PROJECT_A })) as any
    await h('automate.set-enabled')(ctx(USER_ALICE), { starterId: gamma.starter.starterId, enabled: false })

    const all = (await h('automate.list')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A })) as any
    expect(all.starters).toHaveLength(3)
    expect(all.nextCursor).toBeUndefined()

    expect(((await h('automate.list')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A, trigger: 'webhook' })) as any).starters.map((s: any) => s.name)).toEqual(['Beta hook'])
    expect(((await h('automate.list')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A, action: 'start-flow' })) as any).starters).toHaveLength(1)
    expect(((await h('automate.list')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A, status: 'disabled' })) as any).starters.map((s: any) => s.name)).toEqual(['Gamma event'])
    expect(((await h('automate.list')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A, search: 'ALPHA' })) as any).starters).toHaveLength(1)

    const page1 = (await h('automate.list')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A, limit: 2 })) as any
    expect(page1.starters).toHaveLength(2)
    expect(page1.nextCursor).toBeDefined()
    const page2 = (await h('automate.list')(ctx(USER_ALICE), { workspaceId: WORKSPACE_A, limit: 2, cursor: page1.nextCursor })) as any
    expect(page2.starters).toHaveLength(1)
    expect(page2.nextCursor).toBeUndefined()
  })

  it('get devuelve nombres resueltos y stats; list-executions pagina el historial', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Con historial',
      trigger: { type: 'event', eventPattern: 'a.b' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'Ping {{topic}}' },
    })) as any
    const starterId = created.starter.starterId
    for (let i = 0; i < 3; i++) {
      await model.recordExecution({ starterId, workspaceId: WORKSPACE_A, source: 'event', topic: 'a.b', ok: i !== 1, error: i === 1 ? 'boom' : undefined })
    }

    const got = (await h('automate.get')(ctx(USER_ALICE), { starterId })) as any
    expect(got.starter.channelName).toBe('Channel A')
    expect(got.starter.agentName).toBe('Agent A')
    expect(got.starter.avgDailyRuns7d).toBeCloseTo(3 / 7, 1)
    expect(got.starter.lastExecutionAt).toBeDefined()

    const p1 = (await h('automate.list-executions')(ctx(USER_ALICE), { starterId, limit: 2 })) as any
    expect(p1.executions).toHaveLength(2)
    expect(p1.nextCursor).toBeDefined()
    const p2 = (await h('automate.list-executions')(ctx(USER_ALICE), { starterId, limit: 2, cursor: p1.nextCursor })) as any
    expect(p2.executions).toHaveLength(1)
    // The 3 rows may share a createdAt millisecond (order among them is then by
    // executionId, not insertion): assert the pages cover each row exactly once.
    const all = [...p1.executions, ...p2.executions]
    expect(new Set(all.map((e: any) => e.executionId)).size).toBe(3)
    expect(all.filter((e: any) => !e.ok)).toHaveLength(1)

    await expect(h('automate.get')(ctx(USER_ALICE), { starterId: 'starter_nope' })).rejects.toThrow('not found')
  })
})

describe('automate.list-calls', () => {
  it('lista las llamadas de un webhook ordenadas por fecha descendente', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Webhook con llamadas',
      trigger: { type: 'webhook' },
      action: { type: 'create-task', projectId: PROJECT_A, agentId: AGENT_A, titleTemplate: '{{payload.title || "Tarea"}}', instructionsTemplate: 'Do it' },
    })) as any
    const starterId = created.starter.starterId

    await db.collection('automate_webhook_calls').insertMany([
      { callId: 'call_1', starterId, payload: { a: 1 }, createdTask: true, createdAt: '2026-06-29T10:00:00.000Z' },
      { callId: 'call_2', starterId, payload: { a: 2 }, createdTask: false, createdAt: '2026-06-29T12:00:00.000Z' },
    ])

    const result = (await h('automate.list-calls')(ctx(USER_ALICE), { starterId })) as any

    expect(result.calls).toHaveLength(2)
    expect(result.calls[0].callId).toBe('call_2')
    expect(result.calls[1].callId).toBe('call_1')
  })
})

describe('automate.quota', () => {
  it('devuelve el presupuesto diario del usuario que llama: plan, usadas, restantes, reset y starters más activos', async () => {
    await seedBillingPlans(db)
    await db.collection('billing_subscriptions').deleteMany({ userId: USER_ALICE })
    const starter = await model.createStarter({
      name: 'Cada minuto',
      createdBy: USER_ALICE,
      workspaceId: WORKSPACE_A,
      trigger: { type: 'scheduler', cronExpression: '* * * * *' },
      action: { type: 'channel-event', channelId: CH_A, agentId: AGENT_A, eventTemplate: 'tick' },
    })
    for (let i = 0; i < 3; i++) {
      await model.recordExecution({ starterId: starter.starterId, workspaceId: WORKSPACE_A, source: 'scheduler', ok: true, createdBy: USER_ALICE })
    }
    await model.recordExecution({ starterId: starter.starterId, workspaceId: WORKSPACE_A, source: 'scheduler', ok: false, createdBy: USER_ALICE, refused: true, error: 'quota-automate_daily_limit: x' })

    const res = (await h('automate.quota')(ctx(USER_ALICE), {})) as Record<string, any>
    expect(res.limit).toBe(5) // sin suscripción activa → plan Seed
    expect(res.used).toBe(3) // la fila refused no cuenta
    expect(res.remaining).toBe(2)
    expect(res.exhausted).toBe(false)
    expect(res.planName).toBe('Seed')
    expect(res.resetsAt).toMatch(/T00:00:00\.000Z$/)
    expect(res.topStarters).toEqual([{ starterId: starter.starterId, name: 'Cada minuto', workspaceId: WORKSPACE_A, count: 3 }])
  })
})
