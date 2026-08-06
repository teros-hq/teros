/**
 * Tests for `extractPendingFromMessages` — TER-351 + TER-340.
 *
 * The function powers the DB rehydration of `pendingPermissions.current` in
 * `useChatPermissions`. Before extraction the logic was embedded in a useEffect
 * and untestable without React Testing Library.
 */

import { describe, expect, it } from 'bun:test'
import { extractPendingFromMessages } from '../pending-extraction'

function makeToolMessage(
  id: string,
  overrides: Record<string, any> = {},
): any {
  return {
    id,
    channelId: 'ch_test',
    timestamp: new Date('2026-05-20T00:00:00Z'),
    content: {
      type: 'tool_execution',
      toolCallId: `tc_${id}`,
      toolName: 'write-file',
      mcaId: 'mca.teros.filesystem',
      status: 'pending_permission',
      permissionRequestId: `perm_${id}`,
      appId: 'app_fs',
      ...overrides,
    },
  }
}

describe('extractPendingFromMessages', () => {
  it('returns empty when no messageIds', () => {
    expect(extractPendingFromMessages([], {})).toEqual([])
  })

  it('extracts pending_permission tool calls with all required fields', () => {
    const msg = makeToolMessage('m1')
    const result = extractPendingFromMessages(['m1'], { m1: msg })
    expect(result).toEqual([
      {
        requestId: 'perm_m1',
        messageId: 'm1',
        toolCallId: 'tc_m1',
        appId: 'app_fs',
        toolName: 'write-file',
      },
    ])
  })

  it('skips messages with status != pending_permission', () => {
    const m1 = makeToolMessage('m1', { status: 'running' })
    const m2 = makeToolMessage('m2', { status: 'completed' })
    const m3 = makeToolMessage('m3', { status: 'pending_permission' })
    const result = extractPendingFromMessages(['m1', 'm2', 'm3'], { m1, m2, m3 })
    expect(result.map((r) => r.requestId)).toEqual(['perm_m3'])
  })

  it('skips messages missing permissionRequestId (legacy data)', () => {
    const m1 = makeToolMessage('m1', { permissionRequestId: undefined })
    const m2 = makeToolMessage('m2')
    const result = extractPendingFromMessages(['m1', 'm2'], { m1, m2 })
    expect(result.map((r) => r.messageId)).toEqual(['m2'])
  })

  it('skips messages missing appId', () => {
    const m1 = makeToolMessage('m1', { appId: undefined })
    const m2 = makeToolMessage('m2')
    const result = extractPendingFromMessages(['m1', 'm2'], { m1, m2 })
    expect(result.map((r) => r.messageId)).toEqual(['m2'])
  })

  it('skips messages with type != tool_execution', () => {
    const m1: any = {
      id: 'm1',
      channelId: 'ch_test',
      timestamp: new Date(),
      content: { type: 'text', text: 'hello' },
    }
    const m2 = makeToolMessage('m2')
    const result = extractPendingFromMessages(['m1', 'm2'], { m1, m2 })
    expect(result.map((r) => r.messageId)).toEqual(['m2'])
  })

  it('skips messageIds that do not exist in messagesById', () => {
    const m1 = makeToolMessage('m1')
    const result = extractPendingFromMessages(['m1', 'missing'], { m1 })
    expect(result.map((r) => r.messageId)).toEqual(['m1'])
  })

  it('falls back toolName to "unknown" when missing', () => {
    const m1 = makeToolMessage('m1', { toolName: undefined })
    const result = extractPendingFromMessages(['m1'], { m1 })
    expect(result[0].toolName).toBe('unknown')
  })

  it('preserves order of messageIds in result', () => {
    const m1 = makeToolMessage('m1')
    const m2 = makeToolMessage('m2')
    const m3 = makeToolMessage('m3')
    const result = extractPendingFromMessages(['m3', 'm1', 'm2'], { m1, m2, m3 })
    expect(result.map((r) => r.messageId)).toEqual(['m3', 'm1', 'm2'])
  })

  it('handles 3 parallel pending messages (TER-340 flow 3 scenario)', () => {
    const m1 = makeToolMessage('m1')
    const m2 = makeToolMessage('m2')
    const m3 = makeToolMessage('m3')
    const result = extractPendingFromMessages(['m1', 'm2', 'm3'], { m1, m2, m3 })
    expect(result).toHaveLength(3)
    expect(result.map((r) => r.requestId)).toEqual(['perm_m1', 'perm_m2', 'perm_m3'])
  })
})
