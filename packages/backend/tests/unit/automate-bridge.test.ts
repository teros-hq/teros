/**
 * Unit — the WS bridge allowlist and automate.sync-flow-triggers.
 *
 *   1. isBackendActionAllowed: exact / domain wildcard / fail closed.
 *   2. sync-flow-triggers reconciles a flow's triggers as owned start-flow
 *      starters: create, keep webhook token, update cron, delete dropped
 *      kinds, disable when inactive, remove all on delete — only in the
 *      caller's workspace.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { type Db, MongoClient } from 'mongodb'
import { register } from '../../src/handlers/domains/automate'
import { AutomateModel } from '../../src/models/automate'
import { isBackendActionAllowed } from '../../src/services/mca-backend-actions'
import { WorkspaceService } from '../../src/services/workspace-service'
import { WsRouter } from '../../src/ws-framework/WsRouter'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_bridge_test_${Date.now()}`

const USER = 'user_bridge_owner'
const WS = 'work_bridge'
const PROJECT = 'proj_bridge'
const FLOW = 'flow_bridge'
const OTHER_USER = 'user_bridge_other'
const OTHER_WS = 'work_bridge_other'

let client: MongoClient
let db: Db
let model: AutomateModel
type Handler = (ctx: WsHandlerContext, raw: unknown) => Promise<unknown>
let sync: Handler

const ctx = (): WsHandlerContext => ({ userId: USER, sessionId: 's', ip: '127.0.0.1' })

describe('isBackendActionAllowed', () => {
  it('matches exact actions and domain wildcards, fails closed otherwise', () => {
    expect(isBackendActionAllowed(['automate.*'], 'automate.create-starter')).toBe(true)
    expect(isBackendActionAllowed(['automate.get'], 'automate.get')).toBe(true)
    expect(isBackendActionAllowed(['automate.get'], 'automate.delete')).toBe(false)
    expect(isBackendActionAllowed(['automate.*'], 'board.create-task')).toBe(false)
    expect(isBackendActionAllowed(['admin-api.*'], 'admin-api.mca-status')).toBe(true)
    expect(isBackendActionAllowed([], 'automate.get')).toBe(false)
    expect(isBackendActionAllowed(undefined, 'automate.get')).toBe(false)
    expect(isBackendActionAllowed(['automate.*'], 'automate')).toBe(false)
    expect(isBackendActionAllowed(['automate.*'], '')).toBe(false)
  })
})

describe('automate.sync-flow-triggers', () => {
  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
    await client.connect()
    db = client.db(DB_NAME)
    model = new AutomateModel(db)
    await model.ensureIndexes()
    await db.collection('workspaces').insertOne({
      workspaceId: WS,
      name: 'Bridge',
      ownerId: USER,
      status: 'active',
      members: [{ userId: USER, role: 'owner' }],
    })
    await db.collection('workspaces').insertOne({
      workspaceId: OTHER_WS,
      name: 'Other',
      ownerId: OTHER_USER,
      status: 'active',
      members: [{ userId: OTHER_USER, role: 'owner' }],
    })
    await db.collection('projects').insertOne({ projectId: PROJECT, workspaceId: WS, name: 'P', status: 'active' })
    await db.collection('flows').insertOne({ flowId: FLOW, workspaceId: WS, projectId: PROJECT, name: 'Nightly sync', status: 'active' })
    const router = new WsRouter()
    register(router, { db, workspaceService: new WorkspaceService(db), runner: null })
    // biome-ignore lint/suspicious/noExplicitAny: private Map access — repo test pattern
    sync = (router as any).handlers.get('automate.sync-flow-triggers')
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    await db.collection('automate_starters').deleteMany({})
  })

  const call = (body: Record<string, unknown>) =>
    sync(ctx(), { workspaceId: WS, flowId: FLOW, projectId: PROJECT, name: 'Nightly sync', active: true, ...body }) as Promise<any>

  it('creates one owned start-flow starter per trigger and returns the webhook URL once', async () => {
    const r = await call({
      triggers: [
        { type: 'schedule', cronExpression: '0 2 * * *', timezone: 'Europe/Madrid' },
        { type: 'webhook' },
        { type: 'event', topic: 'board.task_moved', rules: [{ toColumnName: 'Done' }] },
      ],
    })
    expect(r.starters).toHaveLength(3)
    expect(r.webhookUrl).toMatch(/\/api\/v1\/webhooks\/[a-f0-9]{64}$/)
    for (const s of r.starters) {
      expect(s.ownerFlowId).toBe(FLOW)
      expect(s.action).toMatchObject({ type: 'start-flow', flowId: FLOW, projectId: PROJECT })
      expect(s.enabled).toBe(true)
    }
    const sched = r.starters.find((s: any) => s.type === 'scheduler')
    expect(sched.trigger).toMatchObject({ cronExpression: '0 2 * * *', timezone: 'Europe/Madrid' })
    expect(sched.trigger.nextRunAt).toBeDefined()
    expect(sched.name).toBe('Nightly sync · schedule')
  })

  it('is idempotent: keeps the webhook token, updates the cron, drops removed kinds, disables when inactive', async () => {
    const first = await call({ triggers: [{ type: 'schedule', cronExpression: '0 2 * * *' }, { type: 'webhook' }] })
    const hook = first.starters.find((s: any) => s.type === 'webhook')
    const sched = first.starters.find((s: any) => s.type === 'scheduler')

    const second = await call({ active: false, triggers: [{ type: 'schedule', cronExpression: '0 3 * * *' }, { type: 'webhook' }] })
    expect(second.webhookUrl).toBeUndefined() // token kept → no new URL
    const hook2 = second.starters.find((s: any) => s.type === 'webhook')
    expect(hook2.starterId).toBe(hook.starterId)
    expect(hook2.trigger.tokenHash).toBe(hook.trigger.tokenHash)
    expect(hook2.enabled).toBe(false)
    const sched2 = second.starters.find((s: any) => s.type === 'scheduler')
    expect(sched2.starterId).toBe(sched.starterId)
    expect(sched2.trigger.cronExpression).toBe('0 3 * * *')
    expect(sched2.enabled).toBe(false)

    const third = await call({ triggers: [{ type: 'webhook' }] })
    expect(third.starters).toHaveLength(1)
    expect(await db.collection('automate_starters').countDocuments({ ownerFlowId: FLOW })).toBe(1)
    expect(third.starters[0].enabled).toBe(true)
  })

  it('remove: true deletes every starter the flow owns and nothing else', async () => {
    await call({ triggers: [{ type: 'schedule', cronExpression: '0 2 * * *' }, { type: 'event', topic: 'a.b' }] })
    await model.createStarter({
      name: 'Unrelated',
      createdBy: USER,
      workspaceId: WS,
      trigger: { type: 'event', eventPattern: 'x.y' },
      action: { type: 'start-flow', flowId: FLOW, projectId: PROJECT },
    })
    const r = (await sync(ctx(), { workspaceId: WS, flowId: FLOW, remove: true })) as any
    expect(r.deleted).toBe(2)
    expect(await db.collection('automate_starters').countDocuments({})).toBe(1)
  })

  it("remove: true from another workspace does not touch this workspace's starters", async () => {
    await call({ triggers: [{ type: 'schedule', cronExpression: '0 2 * * *' }, { type: 'webhook' }] })
    // OTHER_USER owns OTHER_WS (passes the write-role check there) and knows FLOW's id.
    const other: WsHandlerContext = { userId: OTHER_USER, sessionId: 's2', ip: '127.0.0.1' }
    const r = (await sync(other, { workspaceId: OTHER_WS, flowId: FLOW, remove: true })) as any
    expect(r.deleted).toBe(0)
    expect(await db.collection('automate_starters').countDocuments({ ownerFlowId: FLOW, workspaceId: WS })).toBe(2)
  })

  it('rejects unknown trigger kinds and foreign projects', async () => {
    await expect(call({ triggers: [{ type: 'cron', cronExpression: '* * * * *' }] })).rejects.toThrow('triggers[].type')
    await expect(call({ projectId: 'proj_other', triggers: [] })).rejects.toThrow('Project not found')
  })
})
