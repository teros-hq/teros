/**
 * Unit — the "apps emit, Automate listens" event standard.
 *
 *   1. BoardEventService publishes every recorded activity on the bus under a
 *      public `board.*` topic with the workspace in the envelope.
 *   2. app.list-event-topics serves the catalog declared by the installed
 *      apps' manifests (synced into mca_catalog).
 *   3. End to end: a board activity fires an Automate event starter of the
 *      same workspace and none of another workspace.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { type Db, MongoClient } from 'mongodb'
import { BoardEventService, boardEventTopic } from '../../src/services/board-event-service'
import { createListEventTopicsHandler } from '../../src/handlers/domains/app/list-event-topics'
import { AutomateModel } from '../../src/models/automate'
import { AutomateRunner } from '../../src/services/automate-runner'
import { checkCatalogDrift, resetCatalogDriftState } from '../../src/services/event-catalog-drift'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_events_test_${Date.now()}`

const WS = 'work_events_a'
const WS_B = 'work_events_b'

let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  for (const col of ['board_events', 'board_daily_stats', 'apps', 'mca_catalog', 'automate_starters', 'automate_executions', 'channels']) {
    await db.collection(col).deleteMany({})
  }
})

describe('boardEventTopic', () => {
  it('maps internal categories to the public board.* namespace', () => {
    expect(boardEventTopic('task.moved')).toBe('board.task_moved')
    expect(boardEventTopic('task.progress_note')).toBe('board.task_progress_note')
    expect(boardEventTopic('task.dependency_added')).toBe('board.task_dependency_added')
    expect(boardEventTopic('board.task_moved')).toBe('board.task_moved')
    expect(boardEventTopic('board.agent_play_changed')).toBe('board.agent_play_changed')
  })
})

describe('BoardEventService → bus', () => {
  it('publishes each recorded event with details flattened and the workspace envelope', async () => {
    const service = new BoardEventService(db)
    const published: Array<{ topic: string; payload: Record<string, unknown> }> = []
    service.setEventDispatcher(async (topic, payload) => {
      published.push({ topic, payload })
    })

    await service.recordEvent({
      boardId: 'board_1',
      projectId: 'proj_1',
      workspaceId: WS,
      taskId: 'task_1',
      taskTitle: 'Ship it',
      eventType: 'task.moved',
      actor: 'agent_1',
      details: { fromColumn: 'col_todo', toColumn: 'col_review', toColumnName: 'Review' },
    })
    // The dispatcher is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 10))

    expect(published).toHaveLength(1)
    expect(published[0].topic).toBe('board.task_moved')
    expect(published[0].payload).toMatchObject({
      workspaceId: WS,
      projectId: 'proj_1',
      taskId: 'task_1',
      taskTitle: 'Ship it',
      actor: 'agent_1',
      toColumn: 'col_review',
      toColumnName: 'Review',
    })
    expect(typeof published[0].payload.occurredAt).toBe('string')
    // Persisted too (the bus is additive).
    expect(await db.collection('board_events').countDocuments({})).toBe(1)
  })
})

describe('app.list-event-topics', () => {
  it('returns the topics declared by the apps installed in the workspace', async () => {
    await db.collection('mca_catalog').insertMany([
      {
        mcaId: 'mca.telegram',
        name: 'Telegram',
        events: [
          { topic: 'telegram.message.received', description: 'A message arrived', payload: { chatId: 'string', text: 'string' } },
          { topic: 'telegram.message.edited' },
        ],
      },
      { mcaId: 'mca.teros.board-manager', name: 'Boards', events: [{ topic: 'board.task_moved', payload: { toColumn: 'string' } }] },
      { mcaId: 'mca.datetime', name: 'Datetime', events: [] },
    ])
    await db.collection('apps').insertMany([
      { appId: 'app_tg', mcaId: 'mca.telegram', ownerId: WS, name: 'Mi Telegram' },
      { appId: 'app_board', mcaId: 'mca.teros.board-manager', ownerId: WS, name: 'Boards' },
      { appId: 'app_dt', mcaId: 'mca.datetime', ownerId: WS },
      { appId: 'app_tg_other', mcaId: 'mca.telegram', ownerId: WS_B, name: 'Otro' },
    ])

    const handler = createListEventTopicsHandler(db, undefined)
    const ctx: WsHandlerContext = { userId: 'u1', sessionId: 's', ip: '127.0.0.1' }
    const result = (await handler(ctx, { workspaceId: WS })) as { topics: Array<Record<string, unknown>> }

    expect(result.topics.map((t) => t.topic)).toEqual(['board.task_moved', 'telegram.message.edited', 'telegram.message.received'])
    const received = result.topics.find((t) => t.topic === 'telegram.message.received')!
    expect(received).toMatchObject({ appId: 'app_tg', mcaId: 'mca.telegram', appName: 'Mi Telegram', payload: { chatId: 'string', text: 'string' } })

    await expect(handler(ctx, {})).rejects.toThrow('workspaceId')
  })
})

describe('event catalog drift guard', () => {
  it('flags missing declared fields and undeclared topics, accepts complete payloads', async () => {
    resetCatalogDriftState()
    await db.collection('apps').insertOne({ appId: 'app_drift', mcaId: 'mca.drift', ownerId: 'work_x' })
    await db.collection('mca_catalog').insertOne({
      mcaId: 'mca.drift',
      events: [{ topic: 'drift.message', payload: { chatId: 'string', fromName: 'string|null', text: 'string' } }],
    })
    expect(await checkCatalogDrift(db, 'app_drift', 'drift.message', { chatId: '1', fromName: null, text: 'hi', extra: 1 })).toEqual({ kind: 'ok' })
    expect(await checkCatalogDrift(db, 'app_drift', 'drift.message', { chatId: '1', text: 'hi' })).toEqual({ kind: 'missing-fields', missing: ['fromName'] })
    expect(await checkCatalogDrift(db, 'app_drift', 'drift.typing', {})).toEqual({ kind: 'undeclared-topic', declared: ['drift.message'] })
    expect(await checkCatalogDrift(db, 'app_unknown', 'drift.message', {})).toEqual({ kind: 'no-catalog' })
  })
})

describe('board activity → Automate event starter (end to end)', () => {
  it('fires the starter of the same workspace only', async () => {
    const model = new AutomateModel(db)
    await model.ensureIndexes()
    const injected: string[] = []
    const runner = new AutomateRunner({
      db,
      model,
      boardService: {} as any,
      handleScheduledEvent: async (event) => {
        injected.push(event.message)
        return { success: true }
      },
      actionBridgeManager: null,
    })
    const boardEvents = new BoardEventService(db)
    boardEvents.setEventDispatcher(async (topic, payload) => {
      await runner.onEventDispatched({ topic, payload })
    })

    for (const ws of [WS, WS_B]) {
      await model.createStarter({
        name: `review alert ${ws}`,
        createdBy: 'u1',
        workspaceId: ws,
        trigger: { type: 'event', eventPattern: 'board.task_moved', filters: [{ toColumnName: 'Review' }] },
        action: { type: 'channel-event', channelId: `ch_${ws}`, agentId: 'agent_1', eventTemplate: '{{payload.taskTitle}} → {{payload.toColumnName}} ({{payload.workspaceId}})' },
      })
    }

    await boardEvents.recordEvent({
      boardId: 'board_1',
      projectId: 'proj_1',
      workspaceId: WS,
      taskId: 'task_1',
      taskTitle: 'Ship it',
      eventType: 'task.moved',
      actor: 'agent_1',
      details: { toColumn: 'col_review', toColumnName: 'Review' },
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(injected).toEqual([`Ship it → Review (${WS})`])
    const executions = await db.collection('automate_executions').find({}).toArray()
    expect(executions).toHaveLength(1)
    expect(executions[0].workspaceId).toBe(WS)
    expect(executions[0].topic).toBe('board.task_moved')
  })
})
