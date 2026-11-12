/**
 * Unit — migraciones Automate v2.
 *
 *   20261013_001: convierte starters v1 (config plano) a trigger/action.
 *   20261013_002: importa scheduler_recurring_tasks como starters y BORRA las
 *                 originales. Idempotente (ya importadas → solo borra).
 *   20261014_001: correctivo — los starters importados con
 *                 trigger.lastExecutionChannelId eran heartbeats de canal, no
 *                 creadores de tareas: create-task → channel-event.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import migration001 from '../../src/migrations/20261013_001_automate_model_v2'
import migration002 from '../../src/migrations/20261013_002_import_scheduler_legacy'
import migrationRetire from '../../src/migrations/20261014_002_retire_scheduler'
import migration003 from '../../src/migrations/20261014_001_fix_scheduler_action_types'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_mig_test_${Date.now()}`

const WS = 'work_mig_test'
const PROJECT = 'proj_mig_test'
const AGENT = 'agent_mig_test'

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
  for (const col of ['automate_starters', 'scheduler_recurring_tasks', 'scheduler_executions', 'projects', 'agents']) {
    await db.collection(col).deleteMany({})
  }
  await db.collection('projects').insertOne({ projectId: PROJECT, workspaceId: WS, name: 'P', status: 'active' })
  await db.collection('agents').insertOne({ agentId: AGENT, workspaceId: WS, name: 'A', status: 'active' })
})

describe('20261013_001_automate_model_v2', () => {
  it('convierte starter scheduler v1 a trigger/action', async () => {
    await db.collection('automate_starters').insertOne({
      starterId: 's1',
      type: 'scheduler',
      name: 'V1 sched',
      projectId: PROJECT,
      agentId: AGENT,
      createdBy: 'u1',
      workspaceId: WS,
      createdAt: new Date().toISOString(),
      order: 1000,
      enabled: true,
      config: {
        schedulerTaskId: '11',
        cronExpression: '0 9 * * 1-5',
        totalExecutions: 5,
        lastExecutionAt: '2026-10-01T09:00:00.000Z',
        lastExecutionChannelId: 'ch_old',
      },
    })

    await migration001.up(db)

    const doc = await db.collection('automate_starters').findOne({ starterId: 's1' })
    expect(doc!.trigger).toMatchObject({
      type: 'scheduler',
      cronExpression: '0 9 * * 1-5',
      schedulerTaskId: '11',
      totalExecutions: 5,
    })
    expect(doc!.action).toMatchObject({ type: 'create-task', projectId: PROJECT, agentId: AGENT })
    expect(doc!.config).toBeUndefined()
  })

  it('convierte starter webhook v1 y es idempotente', async () => {
    await db.collection('automate_starters').insertOne({
      starterId: 's2',
      type: 'webhook',
      name: 'V1 webhook',
      projectId: PROJECT,
      agentId: AGENT,
      createdBy: 'u1',
      workspaceId: WS,
      createdAt: new Date().toISOString(),
      order: 2000,
      enabled: true,
      config: { tokenHash: 'h'.repeat(64), targetColumnId: 'col_x', callCount: 3, lastCallAt: '2026-10-02T00:00:00.000Z' },
    })

    await migration001.up(db)
    const doc = await db.collection('automate_starters').findOne({ starterId: 's2' })
    expect(doc!.trigger).toMatchObject({ type: 'webhook', tokenHash: 'h'.repeat(64), callCount: 3 })
    expect(doc!.action).toMatchObject({ type: 'create-task', targetColumnId: 'col_x' })

    // Segunda pasada: no rompe ni duplica.
    await migration001.up(db)
    const count = await db.collection('automate_starters').countDocuments({})
    expect(count).toBe(1)
    const doc2 = await db.collection('automate_starters').findOne({ starterId: 's2' })
    expect(doc2!.trigger).toMatchObject({ callCount: 3 })
  })
})

describe('20261013_002_import_scheduler_legacy', () => {
  it('importa tareas legacy como starters y borra las originales', async () => {
    await db.collection('scheduler_recurring_tasks').insertMany([
      {
        id: 1,
        user_id: 'u1',
        workspace_id: WS,
        channel_id: 'ch_1',
        message: 'Daily standup',
        cron_expression: '0 9 * * 1-5',
        enabled: true,
      },
      {
        id: 2,
        user_id: 'u1',
        workspace_id: WS,
        channel_id: 'ch_2',
        message: 'Nightly check',
        cron_expression: '0 23 * * *',
        enabled: false,
      },
    ])
    await db.collection('scheduler_executions').insertMany([
      { task_id: 1, ran_at: Date.now() - 3_600_000, status: 'success' },
      { task_id: 1, ran_at: Date.now() - 7_200_000, status: 'success' },
    ])

    await migration002.up(db)

    // Se importaron 2 starters con el formato v2.
    const starters = await db.collection('automate_starters').find({}).toArray()
    expect(starters).toHaveLength(2)

    const s1 = starters.find((s) => s.trigger?.schedulerTaskId === '1')
    expect(s1).toBeDefined()
    expect(s1!.trigger).toMatchObject({ type: 'scheduler', cronExpression: '0 9 * * 1-5', totalExecutions: 2 })
    expect(s1!.enabled).toBe(true)
    expect(s1!.action).toMatchObject({ type: 'create-task', projectId: PROJECT, agentId: AGENT })

    const s2 = starters.find((s) => s.trigger?.schedulerTaskId === '2')
    expect(s2!.enabled).toBe(false) // respeta el flag legacy

    // Las originales se borraron.
    const legacyCount = await db.collection('scheduler_recurring_tasks').countDocuments({})
    expect(legacyCount).toBe(0)
  })

  it('es idempotente: ya importadas → solo borra, no duplica', async () => {
    await db.collection('scheduler_recurring_tasks').insertOne({
      id: 9,
      user_id: 'u1',
      workspace_id: WS,
      channel_id: 'ch_9',
      message: 'Ya importada',
      cron_expression: '0 12 * * *',
      enabled: true,
    })
    await db.collection('automate_starters').insertOne({
      starterId: 'already',
      type: 'scheduler',
      name: 'Ya importada',
      workspaceId: WS,
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
      order: 1000,
      enabled: true,
      trigger: { type: 'scheduler', cronExpression: '0 12 * * *', schedulerTaskId: '9' },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: '' },
    })

    await migration002.up(db)

    const count = await db.collection('automate_starters').countDocuments({})
    expect(count).toBe(1)
    const legacyCount = await db.collection('scheduler_recurring_tasks').countDocuments({})
    expect(legacyCount).toBe(0)
  })

  it('tarea con canal vivo → action channel-event con el agente del canal', async () => {
    await db.collection('channels').insertOne({ channelId: 'ch_live', workspaceId: WS, agentId: 'agent_live' })
    await db.collection('scheduler_recurring_tasks').insertOne({
      id: 5,
      user_id: 'u1',
      workspace_id: WS,
      channel_id: 'ch_live',
      message: 'Buenos días',
      cron_expression: '0 8 * * *',
      timezone: 'Europe/Madrid',
      next_run: Date.now() + 3_600_000,
      enabled: true,
    })

    await migration002.up(db)

    const starter = await db.collection('automate_starters').findOne({ 'trigger.schedulerTaskId': '5' })
    expect(starter!.action).toMatchObject({ type: 'channel-event', channelId: 'ch_live', agentId: 'agent_live', eventTemplate: 'Buenos días' })
    expect(starter!.trigger).toMatchObject({ timezone: 'Europe/Madrid' })
    expect(typeof starter!.trigger.nextRunAt).toBe('string')
    await db.collection('channels').deleteMany({ channelId: 'ch_live' })
  })

  it('ids legacy por usuario: solo borra la tarea del usuario importado y deja los flow schedules', async () => {
    await db.collection('scheduler_recurring_tasks').insertMany([
      { id: 3, user_id: 'u1', workspace_id: WS, channel_id: 'ch_x', message: 'De u1', cron_expression: '0 8 * * *', enabled: true },
      { id: 3, user_id: 'u2', workspace_id: 'work_other', channel_id: 'ch_y', message: 'De u2', cron_expression: '0 9 * * *', enabled: true },
      { id: 4, user_id: 'u1', workspace_id: WS, channel_id: 'ch_z', message: '{"_flowSchedule":true,"flowId":"flow_1","projectId":"proj_1"}', cron_expression: '0 10 * * *', enabled: true },
    ])

    await migration002.up(db)

    // u1's task imported and deleted; u2's (other workspace, no defaults) kept;
    // the flow schedule never touched.
    expect(await db.collection('automate_starters').countDocuments({ workspaceId: WS })).toBe(1)
    expect(await db.collection('scheduler_recurring_tasks').countDocuments({ id: 3, user_id: 'u1' })).toBe(0)
    expect(await db.collection('scheduler_recurring_tasks').countDocuments({ id: 3, user_id: 'u2' })).toBe(1)
    expect(await db.collection('scheduler_recurring_tasks').countDocuments({ id: 4 })).toBe(1)
  })

  it('workspace sin proyecto/activo → la tarea legacy se conserva', async () => {
    await db.collection('projects').deleteMany({})
    await db.collection('scheduler_recurring_tasks').insertOne({
      id: 77,
      user_id: 'u1',
      workspace_id: WS,
      channel_id: 'ch_77',
      message: 'Sin hogar',
      cron_expression: '0 8 * * *',
      enabled: true,
    })

    await migration002.up(db)

    // No se importó ni se borró.
    const starters = await db.collection('automate_starters').countDocuments({})
    expect(starters).toBe(0)
    const legacy = await db.collection('scheduler_recurring_tasks').countDocuments({})
    expect(legacy).toBe(1)
  })
})

describe('20261014_001_fix_scheduler_action_types', () => {
  it('convierte create-task con lastExecutionChannelId a channel-event', async () => {
    await db.collection('automate_starters').insertOne({
      starterId: 'fix1',
      type: 'scheduler',
      name: 'Heartbeat: revisar el board',
      workspaceId: WS,
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
      order: 1000,
      enabled: false,
      trigger: {
        type: 'scheduler',
        cronExpression: '0 9 * * *',
        schedulerTaskId: '21',
        lastExecutionChannelId: 'ch_target',
      },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: '' },
    })

    await migration003.up(db)

    const doc = await db.collection('automate_starters').findOne({ starterId: 'fix1' })
    expect(doc!.action).toEqual({
      type: 'channel-event',
      channelId: 'ch_target',
      agentId: AGENT,
      eventTemplate: 'Heartbeat: revisar el board',
    })
    // El trigger no se toca.
    expect(doc!.trigger).toMatchObject({ type: 'scheduler', cronExpression: '0 9 * * *' })
    // Backup para el down().
    expect(doc!.actionBackup).toMatchObject({ type: 'create-task', projectId: PROJECT, agentId: AGENT })
  })

  it('no toca starters sin lastExecutionChannelId ni acciones que no sean create-task', async () => {
    await db.collection('automate_starters').insertMany([
      {
        starterId: 'keep1',
        type: 'scheduler',
        name: 'Webhook real de tareas',
        workspaceId: WS,
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        order: 1000,
        enabled: true,
        trigger: { type: 'scheduler', cronExpression: '0 10 * * *' },
        action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_x' },
      },
      {
        starterId: 'keep2',
        type: 'scheduler',
        name: 'Ya convertido',
        workspaceId: WS,
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        order: 2000,
        enabled: true,
        trigger: { type: 'scheduler', cronExpression: '0 11 * * *', lastExecutionChannelId: 'ch_other' },
        action: { type: 'channel-event', channelId: 'ch_other', agentId: AGENT, eventTemplate: 'hola' },
      },
    ])

    await migration003.up(db)

    const keep1 = await db.collection('automate_starters').findOne({ starterId: 'keep1' })
    expect(keep1!.action).toMatchObject({ type: 'create-task', targetColumnId: 'col_x' })
    expect(keep1!.actionBackup).toBeUndefined()

    const keep2 = await db.collection('automate_starters').findOne({ starterId: 'keep2' })
    expect(keep2!.action).toMatchObject({ type: 'channel-event', channelId: 'ch_other' })
    expect(keep2!.actionBackup).toBeUndefined()
  })

  it('es idempotente: segunda pasada no cambia nada', async () => {
    await db.collection('automate_starters').insertOne({
      starterId: 'fix2',
      type: 'scheduler',
      name: 'Monitor deploy',
      workspaceId: WS,
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
      order: 1000,
      enabled: false,
      trigger: { type: 'scheduler', cronExpression: '*/5 * * * *', lastExecutionChannelId: 'ch_x' },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: '' },
    })

    await migration003.up(db)
    const afterFirst = await db.collection('automate_starters').findOne({ starterId: 'fix2' })

    await migration003.up(db)
    const afterSecond = await db.collection('automate_starters').findOne({ starterId: 'fix2' })

    expect(afterSecond!.action).toEqual(afterFirst!.action)
    expect(afterSecond!.action).toMatchObject({ type: 'channel-event', channelId: 'ch_x' })
  })

  it('down() restaura la acción original desde actionBackup', async () => {
    await db.collection('automate_starters').insertOne({
      starterId: 'fix3',
      type: 'scheduler',
      name: 'Heartbeat down',
      workspaceId: WS,
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
      order: 1000,
      enabled: false,
      trigger: { type: 'scheduler', cronExpression: '0 8 * * *', lastExecutionChannelId: 'ch_y' },
      action: { type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_z' },
    })

    await migration003.up(db)
    await migration003.down!(db)

    const doc = await db.collection('automate_starters').findOne({ starterId: 'fix3' })
    expect(doc!.action).toEqual({ type: 'create-task', projectId: PROJECT, agentId: AGENT, targetColumnId: 'col_z' })
    expect(doc!.actionBackup).toBeUndefined()
  })
})

describe('20261014_002_retire_scheduler', () => {
  it('reminders → once starters, flow schedules → owned starters, MCA uninstalled, collections dropped', async () => {
    const at = Date.now() + 3_600_000
    await db.collection('channels').insertOne({ channelId: 'ch_rem', workspaceId: WS, agentId: 'agent_rem' })
    await db.collection('scheduler_reminders').insertMany([
      { id: 1, user_id: 'u1', channel_id: 'ch_rem', message: 'Call back', scheduled_time: at, timezone: 'Europe/Madrid', status: 'pending' },
      { id: 2, user_id: 'u1', channel_id: 'ch_rem', message: 'Old', scheduled_time: at, status: 'sent' },
      { id: 3, user_id: 'u1', channel_id: 'ch_gone', message: 'Orphan', scheduled_time: at, status: 'pending' },
    ])
    await db.collection('flows').insertOne({ flowId: 'flow_r', workspaceId: WS, projectId: PROJECT, name: 'Nightly', status: 'active' })
    await db.collection('scheduler_recurring_tasks').insertMany([
      { id: 10, user_id: 'u1', workspace_id: WS, channel_id: 'system', message: '{"_flowSchedule":true,"flowId":"flow_r","projectId":"' + PROJECT + '"}', cron_expression: '0 2 * * *', timezone: 'UTC', enabled: true },
      { id: 11, user_id: 'u1', workspace_id: WS, channel_id: 'ch_rem', message: 'Late heartbeat', cron_expression: '0 9 * * *', enabled: true },
    ])
    await db.collection('scheduler_executions').insertOne({ task_id: 11, ran_at: Date.now(), status: 'success' })
    await db.collection('apps').insertMany([
      { appId: 'app_sched', mcaId: 'mca.teros.scheduler', ownerId: WS },
      { appId: 'app_other', mcaId: 'mca.telegram', ownerId: WS },
    ])
    await db.collection('agent_app_access').insertMany([{ appId: 'app_sched', agentId: 'a1' }, { appId: 'app_other', agentId: 'a1' }])
    await db.collection('mca_catalog').insertOne({ mcaId: 'mca.teros.scheduler', name: 'Scheduler' })

    await migrationRetire.up(db)

    const once = await db.collection('automate_starters').findOne({ type: 'once' })
    expect(once).not.toBeNull()
    expect(once!.trigger).toMatchObject({ type: 'once', at: new Date(at).toISOString(), nextRunAt: new Date(at).toISOString(), timezone: 'Europe/Madrid', reminderId: '1' })
    expect(once!.action).toMatchObject({ type: 'channel-event', channelId: 'ch_rem', agentId: 'agent_rem', eventTemplate: 'Call back' })
    expect(await db.collection('automate_starters').countDocuments({ type: 'once' })).toBe(1) // sent + orphan dropped

    const flowStarter = await db.collection('automate_starters').findOne({ ownerFlowId: 'flow_r' })
    expect(flowStarter).not.toBeNull()
    expect(flowStarter!.action).toMatchObject({ type: 'start-flow', flowId: 'flow_r', projectId: PROJECT })
    expect(flowStarter!.trigger).toMatchObject({ type: 'scheduler', cronExpression: '0 2 * * *', timezone: 'UTC' })

    // The late heartbeat went through the regular import (channel-event to its channel).
    const heartbeat = await db.collection('automate_starters').findOne({ 'trigger.schedulerTaskId': '11' })
    expect(heartbeat!.action).toMatchObject({ type: 'channel-event', channelId: 'ch_rem', agentId: 'agent_rem' })

    expect(await db.collection('apps').countDocuments({ mcaId: 'mca.teros.scheduler' })).toBe(0)
    expect(await db.collection('apps').countDocuments({})).toBe(1)
    expect(await db.collection('agent_app_access').countDocuments({ appId: 'app_sched' })).toBe(0)
    expect(await db.collection('agent_app_access').countDocuments({ appId: 'app_other' })).toBe(1)
    expect(await db.collection('mca_catalog').countDocuments({ mcaId: 'mca.teros.scheduler' })).toBe(0)

    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect(names.some((n) => n.startsWith('scheduler_'))).toBe(false)

    // Idempotent.
    await migrationRetire.up(db)
    expect(await db.collection('automate_starters').countDocuments({})).toBe(3)
    await db.collection('channels').deleteMany({ channelId: 'ch_rem' })
    await db.collection('flows').deleteMany({ flowId: 'flow_r' })
    await db.collection('apps').deleteMany({})
    await db.collection('agent_app_access').deleteMany({})
    await db.collection('mca_catalog').deleteMany({})
  })
})
