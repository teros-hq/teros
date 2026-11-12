/**
 * create-todo-item action — the to-do list equivalent of create-task.
 *
 * Covers:
 *   1. create-starter validation: happy path (parent group, assignee, state,
 *      plannedDay/Time), workspace scoping of parent and assignee, state
 *      whitelist (blocked rejected), plannedTime requiring plannedDay.
 *   2. Runner execution: template render, node inserted in todo_nodes with
 *      the right shape (log entries, assignee, plan), todo.* events emitted
 *      through the shared emitters, execution recorded.
 *   3. Empty text render is an execution error (no fallbacks).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { type Db, MongoClient } from 'mongodb'
import { register } from '../../src/handlers/domains/automate'
import { WsRouter } from '../../src/ws-framework/WsRouter'
import { WorkspaceService } from '../../src/services/workspace-service'
import { AutomateModel } from '../../src/models/automate'
import { AutomateRunner } from '../../src/services/automate-runner'
import { setMcaActionDeps } from '../../src/mca-actions'
import { TodoSubscriptionService } from '../../src/services/todo-subscription-service'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_todo_test_${Date.now()}`

const USER_ALICE = 'user_aaaaaaaaaaaaaaaa'
const WORKSPACE_A = 'work_aaaaaaaaaaaaaaaa'
const AGENT_A = 'agent_aaaaaaaaaaaaaaaa'
const GROUP_A = 'tn_groupaaaaaaaaaaaa01'
const TASK_LEAF = 'tn_taskaaaaaaaaaaaaa02'

let client: MongoClient
let db: Db
let workspaceService: WorkspaceService
let model: AutomateModel
let runner: AutomateRunner
type Handler = (ctx: WsHandlerContext, raw: unknown) => Promise<unknown>
let handlers: Map<string, Handler>
let todoEvents: Array<{ topic: string; payload: Record<string, unknown> }>

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
  await db.collection('agents').insertOne({
    agentId: AGENT_A,
    name: 'Agent A',
    status: 'active',
    workspaceId: WORKSPACE_A,
  })
  // A group and a task in the workspace's to-do tree.
  await db.collection('todo_nodes').insertOne({
    nodeId: GROUP_A,
    parentId: null,
    workspaceId: WORKSPACE_A,
    text: 'Inbox',
    description: '',
    instructions: '',
    completed: false,
    collapsed: false,
    position: 0,
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    kind: 'group',
  })
  await db.collection('todo_nodes').insertOne({
    nodeId: TASK_LEAF,
    parentId: null,
    workspaceId: WORKSPACE_A,
    text: 'A task',
    description: '',
    instructions: '',
    completed: false,
    collapsed: false,
    position: 1,
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    kind: 'task',
    state: 'pending',
    blockedReason: null,
    progress: null,
    output: null,
    input: null,
  })

  // The todo subscription service with a bus spy — the runner emits todo.*
  // events through the shared emitters.
  todoEvents = []
  const todoSubscriptions = new TodoSubscriptionService(db)
  setMcaActionDeps({
    todoSubscriptions,
    // biome-ignore lint/suspicious/noExplicitAny: bus spy
    ...({} as any),
  })
  // Wire the emitters' bus dispatch to the spy (same hook server-bootstrap sets).
  const { setTodoBusDispatch } = await import('../../src/services/todo-event-emitters')
  setTodoBusDispatch(async (event) => {
    todoEvents.push({ topic: event.topic, payload: event.payload })
    return { matched: 0 }
  })

  runner = new AutomateRunner({
    db,
    model,
    // biome-ignore lint/suspicious/noExplicitAny: minimal board service — create-todo-item never touches it
    boardService: {} as any,
    handleScheduledEvent: async () => ({ success: true }),
    actionBridgeManager: null,
  })

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
  for (const col of ['automate_starters', 'automate_executions', 'todo_nodes']) {
    if (col === 'todo_nodes') continue // keep the seeded group/task
    await db.collection(col).deleteMany({})
  }
  todoEvents.length = 0
  // Clean nodes created by tests, keep the seeds.
  await db.collection('todo_nodes').deleteMany({ nodeId: { $nin: [GROUP_A, TASK_LEAF] } })
})

// ===========================================================================
// Validation
// ===========================================================================

describe('create-starter — create-todo-item validation', () => {
  it('accepts the full shape and normalizes defaults', async () => {
    const result = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Lead follow-up',
      trigger: { type: 'webhook' },
      action: {
        type: 'create-todo-item',
        parentId: GROUP_A,
        assignee: { kind: 'agent', id: AGENT_A },
        state: 'pending',
        plannedDay: '2026-11-02',
        plannedTime: '09:30',
        textTemplate: 'Responder a {{payload.fromName}}',
        descriptionTemplate: 'Lead from webhook',
        instructionsTemplate: 'Write the reply and send it.',
      },
    })) as { starter: { action: Record<string, unknown>; starterId: string } }
    expect(result.starter.action).toMatchObject({
      type: 'create-todo-item',
      parentId: GROUP_A,
      assignee: { kind: 'agent', id: AGENT_A },
      state: 'pending',
      plannedDay: '2026-11-02',
      plannedTime: '09:30',
      textTemplate: 'Responder a {{payload.fromName}}',
    })
  })

  it('accepts a minimal action (root parent, no assignee, no plan)', async () => {
    const result = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Minimal',
      trigger: { type: 'webhook' },
      action: { type: 'create-todo-item', textTemplate: 'Tarea {{payload.x}}' },
    })) as { starter: { action: Record<string, unknown> } }
    expect(result.starter.action).toMatchObject({ type: 'create-todo-item', textTemplate: 'Tarea {{payload.x}}' })
    expect(result.starter.action.parentId).toBeUndefined()
  })

  it('rejects a parent from another workspace', async () => {
    await db.collection('todo_nodes').insertOne({
      nodeId: 'tn_otherws00000000003',
      parentId: null,
      workspaceId: 'work_bbbbbbbbbbbbbbbb',
      text: 'Other',
      kind: 'group',
      log: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'X',
        trigger: { type: 'webhook' },
        action: { type: 'create-todo-item', parentId: 'tn_otherws00000000003', textTemplate: 'T' },
      }),
    ).rejects.toThrow('Parent node not found in workspace')
  })

  it('rejects a task as parent (GROUP_IN_TASK)', async () => {
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'X',
        trigger: { type: 'webhook' },
        action: { type: 'create-todo-item', parentId: TASK_LEAF, textTemplate: 'T' },
      }),
    ).rejects.toThrow('inside groups')
  })

  it('rejects blocked as initial state', async () => {
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'X',
        trigger: { type: 'webhook' },
        action: { type: 'create-todo-item', state: 'blocked', textTemplate: 'T' },
      }),
    ).rejects.toThrow('state')
  })

  it('rejects plannedTime without plannedDay', async () => {
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'X',
        trigger: { type: 'webhook' },
        action: { type: 'create-todo-item', plannedTime: '09:00', textTemplate: 'T' },
      }),
    ).rejects.toThrow('plannedDay')
  })

  it('rejects an assignee from another workspace', async () => {
    await db.collection('agents').insertOne({ agentId: 'agent_bbbbbbbbbbbbbbbb', name: 'B', status: 'active', workspaceId: 'work_bbbbbbbbbbbbbbbb' })
    await expect(
      h('automate.create-starter')(ctx(USER_ALICE), {
        workspaceId: WORKSPACE_A,
        name: 'X',
        trigger: { type: 'webhook' },
        action: { type: 'create-todo-item', assignee: { kind: 'agent', id: 'agent_bbbbbbbbbbbbbbbb' }, textTemplate: 'T' },
      }),
    ).rejects.toThrow('workspace')
  })
})

// ===========================================================================
// Runner execution
// ===========================================================================

describe('AutomateRunner — create-todo-item execution', () => {
  it('creates the node with group, assignee and plan, and emits todo.* events', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Lead follow-up',
      trigger: { type: 'webhook' },
      action: {
        type: 'create-todo-item',
        parentId: GROUP_A,
        assignee: { kind: 'agent', id: AGENT_A },
        plannedDay: '2026-11-02',
        plannedTime: '09:30',
        textTemplate: 'Responder a {{payload.fromName}}',
        descriptionTemplate: 'Email de {{payload.fromName}}',
      },
    })) as { starter: { starterId: string } }

    const result = await runner.executeAction(
      // biome-ignore lint/suspicious/noExplicitAny: starter shape from the model
      { ...((await model.getStarterById(created.starter.starterId)) as any) },
      { source: 'webhook', payload: { fromName: 'Pablo' } },
    )
    expect(result.ok).toBe(true)
    expect(result.actionType).toBe('create-todo-item')
    expect(result.taskId).toMatch(/^tn_/)

    const node = await db.collection('todo_nodes').findOne({ nodeId: result.taskId })
    expect(node).toMatchObject({
      workspaceId: WORKSPACE_A,
      parentId: GROUP_A,
      text: 'Responder a Pablo',
      description: 'Email de Pablo',
      kind: 'task',
      state: 'pending',
      assignee: { kind: 'agent', id: AGENT_A },
      plannedFor: '2026-11-02',
      plannedTime: '09:30',
    })
    expect(node?.log?.[0]?.text).toContain('Created by automation')

    // Events through the shared emitters: task_created, task_assigned, task_planned.
    const topics = todoEvents.map((e) => e.topic).sort()
    expect(topics).toEqual(['todo.task_assigned', 'todo.task_created', 'todo.task_planned'])
    const created2 = todoEvents.find((e) => e.topic === 'todo.task_created')
    expect(created2?.payload).toMatchObject({ nodeId: result.taskId, text: 'Responder a Pablo', parentText: 'Inbox', workspaceId: WORKSPACE_A })

    // The execution is audited.
    const execution = await db.collection('automate_executions').findOne({ starterId: created.starter.starterId })
    expect(execution).toMatchObject({ ok: true, taskId: result.taskId })
  })

  it('fails the execution when the text template renders empty (no fallbacks)', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Empty render',
      trigger: { type: 'webhook' },
      action: { type: 'create-todo-item', textTemplate: '{{payload.fromName}}' },
    })) as { starter: { starterId: string } }

    const result = await runner.executeAction(
      // biome-ignore lint/suspicious/noExplicitAny: starter shape from the model
      { ...((await model.getStarterById(created.starter.starterId)) as any) },
      { source: 'webhook', payload: {} },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('EMPTY_TEXT')
  })

  it('fails gracefully when the parent group was deleted after creation', async () => {
    const created = (await h('automate.create-starter')(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_A,
      name: 'Ghost parent',
      trigger: { type: 'webhook' },
      action: { type: 'create-todo-item', parentId: GROUP_A, textTemplate: 'Tarea' },
    })) as { starter: { starterId: string } }
    await db.collection('todo_nodes').deleteOne({ nodeId: GROUP_A })

    const result = await runner.executeAction(
      // biome-ignore lint/suspicious/noExplicitAny: starter shape from the model
      { ...((await model.getStarterById(created.starter.starterId)) as any) },
      { source: 'webhook', payload: {} },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Parent node not found')
  })
})
