/**
 * AutomateApi — contract / boundary tests (model v2).
 *
 * Verifies that AutomateApi maps each method to the correct WebSocket action
 * and payload shape. Uses CapturingTransport so these tests are fast and do
 * not require a real backend.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { AutomateApi } from '../AutomateApi'
import { CapturingTransport } from './_helpers'

describe('AutomateApi — action + payload contract (v2)', () => {
  let transport: CapturingTransport
  let api: AutomateApi

  beforeEach(() => {
    transport = new CapturingTransport()
    api = new AutomateApi(transport)
  })

  it('listStarters sends automate.list with workspaceId', async () => {
    await api.listStarters('ws_1')
    expect(transport.last()).toEqual({
      action: 'automate.list',
      payload: { workspaceId: 'ws_1' },
      options: undefined,
    })
  })

  it('createStarter sends automate.create-starter with trigger + action', async () => {
    await api.createStarter('ws_1', {
      name: 'GitHub → tasks',
      trigger: { type: 'webhook' },
      action: {
        type: 'create-task',
        projectId: 'proj_1',
        agentId: 'agent_1',
        targetColumnId: 'col_todo',
        titleTemplate: 'Issue {{payload.title}}',
        instructionsTemplate: 'Triage it',
      },
    })
    expect(transport.last()).toEqual({
      action: 'automate.create-starter',
      payload: {
        workspaceId: 'ws_1',
        name: 'GitHub → tasks',
        trigger: { type: 'webhook' },
        action: {
          type: 'create-task',
          projectId: 'proj_1',
          agentId: 'agent_1',
          targetColumnId: 'col_todo',
        },
      },
      options: undefined,
    })
  })

  it('createStarter supports scheduler trigger + channel-event action', async () => {
    await api.createStarter('ws_1', {
      name: 'Daily alert',
      trigger: { type: 'scheduler', cronExpression: '0 9 * * 1-5' },
      action: { type: 'channel-event', channelId: 'ch_1', agentId: 'agent_1', eventTemplate: 'Ping' },
      enabled: false,
    })
    expect(transport.last().payload).toEqual({
      workspaceId: 'ws_1',
      name: 'Daily alert',
      trigger: { type: 'scheduler', cronExpression: '0 9 * * 1-5' },
      action: { type: 'channel-event', channelId: 'ch_1', agentId: 'agent_1', eventTemplate: 'Ping' },
      enabled: false,
    })
  })

  it('createStarter supports event trigger + start-flow action with inputMapping', async () => {
    await api.createStarter('ws_1', {
      name: 'Issue → flow',
      trigger: { type: 'event', eventPattern: 'github.issue.*', filters: [{ action: 'opened' }] },
      action: {
        type: 'start-flow',
        flowId: 'flow_1',
        projectId: 'proj_1',
        inputMapping: { issueNumber: 'payload.number' },
      },
    })
    expect(transport.last().payload).toEqual({
      workspaceId: 'ws_1',
      name: 'Issue → flow',
      trigger: { type: 'event', eventPattern: 'github.issue.*', filters: [{ action: 'opened' }] },
      action: {
        type: 'start-flow',
        flowId: 'flow_1',
        projectId: 'proj_1',
        inputMapping: { issueNumber: 'payload.number' },
      },
    })
  })

  it('updateStarter sends automate.update-starter with the patch', async () => {
    await api.updateStarter('ws_1', 'starter_1', {
      name: 'Renamed',
      action: { type: 'create-task', projectId: 'proj_2', agentId: 'agent_2', targetColumnId: '', titleTemplate: 'Issue {{payload.title}}', instructionsTemplate: 'Triage it' },
    })
    expect(transport.last()).toEqual({
      action: 'automate.update-starter',
      payload: {
        workspaceId: 'ws_1',
        starterId: 'starter_1',
        name: 'Renamed',
        action: { type: 'create-task', projectId: 'proj_2', agentId: 'agent_2', targetColumnId: '', titleTemplate: 'Issue {{payload.title}}', instructionsTemplate: 'Triage it' },
      },
      options: undefined,
    })
  })

  it('deleteStarter sends automate.delete', async () => {
    await api.deleteStarter('ws_1', 'starter_1')
    expect(transport.last()).toEqual({
      action: 'automate.delete',
      payload: { workspaceId: 'ws_1', starterId: 'starter_1' },
      options: undefined,
    })
  })

  it('setEnabled sends automate.set-enabled', async () => {
    await api.setEnabled('ws_1', 'starter_1', false)
    expect(transport.last()).toEqual({
      action: 'automate.set-enabled',
      payload: { workspaceId: 'ws_1', starterId: 'starter_1', enabled: false },
      options: undefined,
    })
  })

  it('regenerateWebhookUrl sends automate.regenerate-url', async () => {
    await api.regenerateWebhookUrl('ws_1', 'starter_1')
    expect(transport.last()).toEqual({
      action: 'automate.regenerate-url',
      payload: { workspaceId: 'ws_1', starterId: 'starter_1' },
      options: undefined,
    })
  })

  it('listWebhookCalls sends automate.list-calls', async () => {
    await api.listWebhookCalls('starter_1')
    expect(transport.last()).toEqual({
      action: 'automate.list-calls',
      payload: { starterId: 'starter_1' },
      options: undefined,
    })
  })

  it('testWebhook sends automate.test-webhook with payload', async () => {
    await api.testWebhook('starter_1', { number: 7 })
    expect(transport.last()).toEqual({
      action: 'automate.test-webhook',
      payload: { starterId: 'starter_1', payload: { number: 7 } },
      options: undefined,
    })
  })

  it('getStarter, listExecutions and listEventTopics map to their actions', async () => {
    await api.getStarter('starter_1')
    expect(transport.last()).toEqual({ action: 'automate.get', payload: { starterId: 'starter_1' }, options: undefined })
    await api.listExecutions('starter_1', { limit: 20, cursor: 'c' })
    expect(transport.last()).toEqual({
      action: 'automate.list-executions',
      payload: { starterId: 'starter_1', limit: 20, cursor: 'c' },
      options: undefined,
    })
    await api.listEventTopics('ws_1')
    expect(transport.last()).toEqual({ action: 'app.list-event-topics', payload: { workspaceId: 'ws_1' }, options: undefined })
  })

  it('createStarter supports the once trigger and idempotencyKey', async () => {
    await api.createStarter('ws_1', {
      name: 'Reminder',
      trigger: { type: 'once', at: '2026-10-15T09:00:00.000Z', timezone: 'Europe/Madrid' },
      action: { type: 'channel-event', channelId: 'ch_1', agentId: 'agent_1', eventTemplate: 'Ping' },
      idempotencyKey: 'k',
    } as any)
    expect(transport.last().payload).toMatchObject({ trigger: { type: 'once', at: '2026-10-15T09:00:00.000Z' }, idempotencyKey: 'k' })
  })

  it('listFlows sends automate.list-flows', async () => {
    await api.listFlows('ws_1')
    expect(transport.last()).toEqual({
      action: 'automate.list-flows',
      payload: { workspaceId: 'ws_1' },
      options: undefined,
    })
  })
})
