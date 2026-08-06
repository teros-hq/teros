/**
 * Direct unit tests for the layered helpers in `streaming-state.ts` — TER-351.
 *
 * Each helper is tested in isolation:
 *   - buildToolStatusContent: pure builder, no I/O.
 *   - buildToolStatusChunk: pure builder, no I/O.
 *   - persistToolStatus: delegates to channelManager.updateMessageContent.
 *   - notifyObserverPermission: emits via eventHandler.handleScheduledEvent
 *     when channel has originChannelId, errors are swallowed.
 *
 * `updateToolStatus` (the orchestrator) is covered by integration tests
 * (permission-manager-hardening + headless-observer-chain ejercitan el flow
 * completo end-to-end).
 */

import { describe, expect, it, mock } from 'bun:test'
import {
  buildToolStatusChunk,
  buildToolStatusContent,
  createStreamingHelpers,
  createStreamingState,
  notifyObserverPermission,
  persistToolStatus,
  persistToolStatusFields,
  type ToolStatusContent,
} from '../../src/handlers/message/streaming-state'

const TOOL = {
  toolCallId: 'tc_1',
  toolName: 'write-file',
  mcaId: 'mca.teros.filesystem',
  input: { path: '/tmp/x' },
}
const FIXED_NOW = new Date('2026-05-20T10:00:00.000Z')

describe('buildToolStatusContent', () => {
  it('builds content without permission fields for status=running', () => {
    const { content, permissionRequestedAt } = buildToolStatusContent(
      TOOL,
      'running',
      undefined,
      FIXED_NOW,
    )
    expect(content).toEqual({
      type: 'tool_execution',
      toolCallId: 'tc_1',
      toolName: 'write-file',
      mcaId: 'mca.teros.filesystem',
      input: { path: '/tmp/x' },
      status: 'running',
    })
    expect(permissionRequestedAt).toBeUndefined()
  })

  it('builds content with permission fields + timestamp for status=pending_permission', () => {
    const { content, permissionRequestedAt } = buildToolStatusContent(
      TOOL,
      'pending_permission',
      { permissionRequestId: 'perm_a', appId: 'app_fs', irreversible: true },
      FIXED_NOW,
    )
    expect(content.permissionRequestId).toBe('perm_a')
    expect(content.appId).toBe('app_fs')
    expect(content.irreversible).toBe(true)
    expect(content.permissionRequestedAt).toBe('2026-05-20T10:00:00.000Z')
    expect(permissionRequestedAt).toBe('2026-05-20T10:00:00.000Z')
  })

  it('omits irreversible from content when not set', () => {
    const { content } = buildToolStatusContent(
      TOOL,
      'pending_permission',
      { permissionRequestId: 'perm_a', appId: 'app_fs' },
      FIXED_NOW,
    )
    expect('irreversible' in content).toBe(false)
  })

  it('does NOT add permissionRequestedAt for non-pending_permission status', () => {
    const { content, permissionRequestedAt } = buildToolStatusContent(
      TOOL,
      'completed',
      { permissionRequestId: 'perm_a' },
      FIXED_NOW,
    )
    expect(content.permissionRequestedAt).toBeUndefined()
    expect(permissionRequestedAt).toBeUndefined()
  })
})

describe('buildToolStatusChunk', () => {
  it('produces broadcast shape WITHOUT permission fields for non-pending_permission', () => {
    const chunk = buildToolStatusChunk({
      channelId: 'ch_x',
      messageId: 'msg_x',
      toolCallId: 'tc_1',
      status: 'running',
      now: 1700000000000,
    })
    expect(chunk).toEqual({
      type: 'message_chunk',
      channelId: 'ch_x',
      messageId: 'msg_x',
      chunkType: 'tool_status_update',
      toolCallId: 'tc_1',
      toolStatus: 'running',
      timestamp: 1700000000000,
    })
  })

  it('includes permission fields when status=pending_permission AND permissionRequestId set', () => {
    const chunk = buildToolStatusChunk({
      channelId: 'ch_x',
      messageId: 'msg_x',
      toolCallId: 'tc_1',
      status: 'pending_permission',
      permissionRequestId: 'perm_a',
      appId: 'app_fs',
      permissionRequestedAt: '2026-05-20T10:00:00.000Z',
      irreversible: true,
      now: 1700000000000,
    })
    expect(chunk.permissionRequestId).toBe('perm_a')
    expect(chunk.appId).toBe('app_fs')
    expect(chunk.permissionRequestedAt).toBe('2026-05-20T10:00:00.000Z')
    expect(chunk.irreversible).toBe(true)
  })

  it('omits permission fields when status=pending_permission WITHOUT permissionRequestId', () => {
    const chunk = buildToolStatusChunk({
      channelId: 'ch_x',
      messageId: 'msg_x',
      toolCallId: 'tc_1',
      status: 'pending_permission',
      // no permissionRequestId
    })
    expect('permissionRequestId' in chunk).toBe(false)
    expect('appId' in chunk).toBe(false)
  })
})

describe('persistToolStatus', () => {
  it('delegates to channelManager.updateMessageContent with content', async () => {
    const updateMessageContent = mock(async () => undefined)
    const channelManager: any = { updateMessageContent }
    const content: ToolStatusContent = {
      type: 'tool_execution',
      toolCallId: 'tc_1',
      toolName: 'write-file',
      status: 'pending_permission',
      permissionRequestId: 'perm_a',
    }
    await persistToolStatus(channelManager, 'msg_x', content)
    expect(updateMessageContent).toHaveBeenCalledWith('msg_x', content)
  })

  it('propagates DB error (caller decides whether to recover)', async () => {
    const channelManager: any = {
      updateMessageContent: mock(async () => {
        throw new Error('DB connection lost')
      }),
    }
    const content: ToolStatusContent = {
      type: 'tool_execution',
      toolCallId: 'tc_1',
      toolName: 'x',
      status: 'running',
    }
    let err: Error | null = null
    try {
      await persistToolStatus(channelManager, 'msg_x', content)
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toBe('DB connection lost')
  })
})

describe('persistToolStatusFields', () => {
  it('writes only status + permission fields, never identity fields', async () => {
    const updateMessageContentFields = mock(async () => undefined)
    const channelManager: any = { updateMessageContentFields }
    const content: ToolStatusContent = {
      type: 'tool_execution',
      toolCallId: 'tc_1',
      toolName: '', // desynced map — blank name must NOT reach the DB
      status: 'pending_permission',
      permissionRequestId: 'perm_a',
      appId: 'app_fs',
      permissionRequestedAt: '2026-05-20T10:00:00.000Z',
      irreversible: true,
    }
    await persistToolStatusFields(channelManager, 'msg_x', content)
    expect(updateMessageContentFields).toHaveBeenCalledWith('msg_x', {
      status: 'pending_permission',
      permissionRequestId: 'perm_a',
      appId: 'app_fs',
      permissionRequestedAt: '2026-05-20T10:00:00.000Z',
      irreversible: true,
    })
  })

  it('writes just the status for non-permission transitions', async () => {
    const updateMessageContentFields = mock(async () => undefined)
    const channelManager: any = { updateMessageContentFields }
    const content: ToolStatusContent = {
      type: 'tool_execution',
      toolCallId: 'tc_1',
      toolName: '',
      status: 'running',
    }
    await persistToolStatusFields(channelManager, 'msg_x', content)
    expect(updateMessageContentFields).toHaveBeenCalledWith('msg_x', { status: 'running' })
  })
})

describe('notifyObserverPermission', () => {
  it('emits channel_permission event when channel has originChannelId', async () => {
    const handleScheduledEvent = mock(async () => undefined)
    const eventHandler: any = { handleScheduledEvent }
    const channelManager: any = {
      getChannel: mock(async () => ({
        channelId: 'ch_sub',
        originChannelId: 'ch_parent',
        metadata: { name: 'QA-Executor' },
      })),
    }

    await notifyObserverPermission({
      channelManager,
      eventHandler,
      channelId: 'ch_sub',
      toolName: 'write-file',
      appId: 'app_fs',
      permissionRequestId: 'perm_a',
    })

    expect(handleScheduledEvent).toHaveBeenCalledTimes(1)
    const call = handleScheduledEvent.mock.calls[0][0]
    expect(call.channelId).toBe('ch_parent')
    expect(call.eventType).toBe('channel_permission')
    expect(call.metadata.observedChannelId).toBe('ch_sub')
    expect(call.metadata.observedChannelName).toBe('QA-Executor')
    expect(call.metadata.toolName).toBe('write-file')
  })

  it('NO emits when channel has no originChannelId', async () => {
    const handleScheduledEvent = mock(async () => undefined)
    const channelManager: any = {
      getChannel: mock(async () => ({ channelId: 'ch_solo', originChannelId: null })),
    }
    await notifyObserverPermission({
      channelManager,
      eventHandler: { handleScheduledEvent } as any,
      channelId: 'ch_solo',
      toolName: 'x',
    })
    expect(handleScheduledEvent).not.toHaveBeenCalled()
  })

  it('swallows errors silently (does not propagate)', async () => {
    const channelManager: any = {
      getChannel: mock(async () => {
        throw new Error('DB hiccup')
      }),
    }
    let err: Error | null = null
    try {
      await notifyObserverPermission({
        channelManager,
        eventHandler: { handleScheduledEvent: mock(async () => undefined) } as any,
        channelId: 'ch_x',
        toolName: 'x',
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeNull()
  })
})

// ===========================================================================
// updateToolStatus — streamState desync resilience (TER-369)
// ===========================================================================
//
// The per-turn streamState's `activeToolCalls` map can be empty while the tool
// is still tracked by the longer-lived McaToolExecutor: reload/resume under
// TER-267 isolation, or the ChannelWorker replaying turns ≥2 through the first
// turn's turnDriver (frozen-dep disease, see TER-386). The caller
// (onPendingPermission) resolves messageId/toolName via the executor and passes
// them in `options`. updateToolStatus MUST still broadcast the
// `tool_status_update` AND persist the status transition (field-level, so the
// record from tool_call_start is not clobbered) — otherwise the permission
// widget never survives a reload and restart-restore can't find the request.

function makeHelpers() {
  const broadcasts: Array<{ cid: string; msg: any }> = []
  const persisted: Array<{ messageId: string; content: any }> = []
  const persistedFields: Array<{ messageId: string; fields: any }> = []
  const state = createStreamingState()
  const channelManager = {
    updateMessageContent: mock(async (messageId: string, content: any) => {
      persisted.push({ messageId, content })
    }),
    updateMessageContentFields: mock(async (messageId: string, fields: any) => {
      persistedFields.push({ messageId, fields })
    }),
    createMessageId: () => 'msg_generated',
    getChannel: mock(async () => null),
  }
  const helpers = createStreamingHelpers(state, {
    channelManager,
    channelId: 'ch_1',
    agentId: 'agent_1',
    broadcastToChannel: (cid: string, msg: any) => broadcasts.push({ cid, msg }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal deps for the unit
  } as any)
  return { state, helpers, broadcasts, persisted, persistedFields, channelManager }
}

describe('updateToolStatus — streamState desync resilience (TER-369)', () => {
  it('broadcasts AND field-persists pending_permission via options.messageId when the tool is ABSENT from the streamState', async () => {
    const { helpers, broadcasts, persisted, persistedFields } = makeHelpers()
    // activeToolCalls is empty — simulates the reload/resume or stale-worker desync.
    await helpers.updateToolStatus('pending_permission', {
      toolCallId: 'tc_42',
      messageId: 'msg_from_executor',
      toolName: 'whatsapp_send-text',
      permissionRequestId: 'perm_x',
      appId: 'app_y',
    })
    // The broadcast MUST fire so the frontend renders the ControlsBar.
    expect(broadcasts.length).toBe(1)
    const chunk = broadcasts[0].msg
    expect(chunk.chunkType).toBe('tool_status_update')
    expect(chunk.messageId).toBe('msg_from_executor')
    expect(chunk.toolStatus).toBe('pending_permission')
    expect(chunk.permissionRequestId).toBe('perm_x')
    // Full-content persist is skipped (would clobber the tool_call_start
    // record), but the status transition IS written field-level so the widget
    // rehydrates after reload and restart-restore finds the request.
    expect(persisted.length).toBe(0)
    expect(persistedFields.length).toBe(1)
    expect(persistedFields[0].messageId).toBe('msg_from_executor')
    expect(persistedFields[0].fields.status).toBe('pending_permission')
    expect(persistedFields[0].fields.permissionRequestId).toBe('perm_x')
    expect(persistedFields[0].fields.appId).toBe('app_y')
    // Identity fields never travel through the partial path.
    expect('toolName' in persistedFields[0].fields).toBe(false)
    expect('input' in persistedFields[0].fields).toBe(false)
  })

  it('notifies the observer with the toolName resolved from options when the streamState is desynced', async () => {
    const broadcasts: Array<{ cid: string; msg: any }> = []
    const handleScheduledEvent = mock(async () => undefined)
    const state = createStreamingState()
    const channelManager: any = {
      updateMessageContent: mock(async () => undefined),
      updateMessageContentFields: mock(async () => undefined),
      createMessageId: () => 'msg_generated',
      getChannel: mock(async () => ({
        channelId: 'ch_worker',
        originChannelId: 'ch_voice',
        metadata: { name: 'Voice Task' },
      })),
    }
    const helpers = createStreamingHelpers(state, {
      channelManager,
      channelId: 'ch_worker',
      agentId: 'agent_1',
      broadcastToChannel: (cid: string, msg: any) => broadcasts.push({ cid, msg }),
      eventHandler: { handleScheduledEvent },
      // biome-ignore lint/suspicious/noExplicitAny: minimal deps for the unit
    } as any)

    await helpers.updateToolStatus('pending_permission', {
      toolCallId: 'tc_42',
      messageId: 'msg_from_executor',
      toolName: 'whatsapp_send-text',
      permissionRequestId: 'perm_x',
      appId: 'app_y',
    })

    // Before the fix this event carried an empty toolName ("needs permission
    // for ") and the voice agent announced a nameless tool.
    expect(handleScheduledEvent).toHaveBeenCalledTimes(1)
    const call = handleScheduledEvent.mock.calls[0][0]
    expect(call.eventType).toBe('channel_permission')
    expect(call.metadata.toolName).toBe('whatsapp_send-text')
    expect(call.message).toContain('whatsapp_send-text')
  })

  it('persists AND broadcasts (tracked messageId wins) when the tool IS in the streamState', async () => {
    const { state, helpers, broadcasts, persisted } = makeHelpers()
    state.activeToolCalls.set('tc_42', {
      messageId: 'msg_tracked',
      toolCallId: 'tc_42',
      toolName: 'insert',
      mcaId: 'mca.notion',
      input: {},
    })
    await helpers.updateToolStatus('pending_permission', {
      toolCallId: 'tc_42',
      messageId: 'msg_from_executor',
      permissionRequestId: 'perm_x',
      appId: 'app_y',
    })
    expect(persisted.length).toBe(1)
    expect(persisted[0].messageId).toBe('msg_tracked')
    expect(broadcasts.length).toBe(1)
    expect(broadcasts[0].msg.messageId).toBe('msg_tracked')
  })

  it('no-ops when neither the streamState nor options carry a messageId', async () => {
    const { helpers, broadcasts, persisted } = makeHelpers()
    await helpers.updateToolStatus('pending_permission', {
      toolCallId: 'tc_42',
      permissionRequestId: 'perm_x',
    })
    expect(broadcasts.length).toBe(0)
    expect(persisted.length).toBe(0)
  })
})
