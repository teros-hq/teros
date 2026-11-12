/**
 * PERMB-REQ-2 — the permission marker never reaches the chat as a completion.
 */
import { describe, expect, it, mock } from 'bun:test'
import { handleStreamEvent } from '../../src/handlers/message/agent-loop'

function makeHarness() {
  const broadcastToChannel = mock(() => {})
  const completeToolMessage = mock(async () => {})
  const ctx: any = {
    broadcastToChannel,
    channelManager: { getChannel: mock(async () => null) },
    maybeAutonameChannel: mock(async () => {}),
  }
  const streamHelpers: any = {
    getToolCall: () => ({ messageId: 'msg_tool_1', toolCallId: 'tc_1', toolName: 'x_recall' }),
    completeToolMessage,
  }
  const streamState: any = { savedMessages: [] }
  return { ctx, streamHelpers, streamState, broadcastToChannel, completeToolMessage }
}

const marker = JSON.stringify({
  status: 'permission_requested',
  permissionRequestId: 'perm_1',
  tool: 'x_recall',
  appId: 'app_x',
  irreversible: false,
  instruction: 'End your turn.',
})

describe('agent-loop — tool_complete with the permission marker', () => {
  it('[PERMB-AC-2] does not broadcast tool_call_complete for the permission marker (the card stays pending)', async () => {
    const h = makeHarness()
    await handleStreamEvent(
      h.ctx,
      { message: { type: 'tool_complete', toolId: 'tc_1', status: 'completed', output: marker, duration: 3 } } as any,
      'ch_1',
      h.streamState,
      h.streamHelpers,
      null,
    )
    const chunks = h.broadcastToChannel.mock.calls.map((c: any[]) => c[1]?.chunkType)
    expect(chunks).not.toContain('tool_call_complete')
    // The record path still runs (it keeps pending_permission on its own).
    expect(h.completeToolMessage).toHaveBeenCalledTimes(1)
  })

  it('[PERMB-AC-2] a real result is still broadcast as tool_call_complete', async () => {
    const h = makeHarness()
    await handleStreamEvent(
      h.ctx,
      { message: { type: 'tool_complete', toolId: 'tc_1', status: 'completed', output: '{"ok":true}', duration: 3 } } as any,
      'ch_1',
      h.streamState,
      h.streamHelpers,
      null,
    )
    const chunk = h.broadcastToChannel.mock.calls.map((c: any[]) => c[1]).find((c: any) => c?.chunkType === 'tool_call_complete')
    expect(chunk?.toolOutput).toBe('{"ok":true}')
  })
})
