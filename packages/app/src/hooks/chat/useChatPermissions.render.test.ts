/**
 * useChatPermissions — permission lifecycle safety net (TER-451 / class TER-369).
 *
 * This hook is the client side of the permission flow whose failure caused TER-369
 * (the ControlsBar never rendered → tools auto-denied). It has 0 tests despite being
 * security-critical. These cover the behaviours that MUST hold:
 *   - a request with no way to render the inline approver is AUTO-DENIED (never granted)
 *   - grant/deny/always send the exact respond payload + persist the allow/forbid rule
 *   - DB rehydration on mount (TER-340) registers pendings so a later grant resolves the card
 *   - the multi-tab filter (GAP-C) ignores events for other channels
 *   - the listener is torn down on unmount
 *
 *   cd packages/app && npx vitest run src/hooks/chat/useChatPermissions.render.test.ts
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Faithful fake WS client: on/off mutate handler sets (like the real EventEmitter),
// emit dispatches to them, and the response surface is spied.
class FakeClient {
  private listeners = new Map<string, Set<(d: unknown) => void>>()
  on(event: string, handler: (d: unknown) => void): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
  }
  off(event: string, handler: (d: unknown) => void): void {
    this.listeners.get(event)?.delete(handler)
  }
  emit(event: string, data: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(data)
  }
  count(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
  respondToToolPermission = vi.fn()
  app = { updateToolPermission: vi.fn(async () => {}) }
}

const hoisted = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => hoisted.client,
}))
// Web Audio API doesn't exist in jsdom; the real hook calls new AudioContext().
vi.mock('../usePermissionSound', () => ({
  usePermissionSound: () => ({ playPermissionSound: vi.fn() }),
}))

import { useChatPermissions } from './useChatPermissions'
import { useChatStore } from '../../store/chatStore'

let fakeClient: FakeClient

// A persisted pending_permission tool message, the shape extractPendingFromMessages
// rehydrates (TER-340).
function seedPending(channelId: string, messageId: string, requestId: string) {
  useChatStore.getState().upsertMessage({
    id: messageId,
    channelId,
    content: {
      type: 'tool_execution',
      status: 'pending_permission',
      permissionRequestId: requestId,
      toolCallId: `tc_${requestId}`,
      appId: 'app_1',
      toolName: 'files-read',
    },
    sender: 'agent',
    timestamp: new Date(),
  } as never)
}

function statusOf(messageId: string): string | undefined {
  const m = useChatStore.getState().messages[messageId]
  return (m?.content as { status?: string } | undefined)?.status
}

describe('useChatPermissions — permission safety net (TER-451 / TER-369)', () => {
  beforeEach(() => {
    fakeClient = new FakeClient()
    hoisted.client = fakeClient
    useChatStore.setState({ messages: {}, channelMessages: {} })
  })

  it('AUTO-DENIES a request with no messageId and no toolCallId (TER-369 fail-safe)', () => {
    renderHook(() => useChatPermissions('ch_A'))
    act(() => {
      fakeClient.emit('tool_permission_request', {
        requestId: 'req_x',
        toolName: 'rm-rf',
        appId: 'app_1',
        channelId: 'ch_A',
      })
    })
    // Never auto-GRANT when the user can't see an approver — deny is the safe default.
    expect(fakeClient.respondToToolPermission).toHaveBeenCalledWith('req_x', false)
  })

  it('ignores a request targeted at another channel (GAP-C multi-tab filter)', () => {
    renderHook(() => useChatPermissions('ch_A'))
    act(() => {
      fakeClient.emit('tool_permission_request', {
        requestId: 'req_other',
        toolName: 't',
        appId: 'app_1',
        channelId: 'ch_B',
      })
    })
    expect(fakeClient.respondToToolPermission).not.toHaveBeenCalled()
  })

  it('rehydrates pendings from the store on mount (TER-340): grant resolves the real card', () => {
    seedPending('ch_A', 'msg_1', 'req_1')
    const { result } = renderHook(() => useChatPermissions('ch_A'))
    expect(statusOf('msg_1')).toBe('pending_permission')
    act(() => {
      result.current.onGrant('req_1')
    })
    expect(fakeClient.respondToToolPermission).toHaveBeenCalledWith('req_1', true)
    // Only possible if the on-mount rehydration registered req_1 → the card moves to running.
    expect(statusOf('msg_1')).toBe('running')
  })

  it('onDeny sends respond(false) and fails the rehydrated card', () => {
    seedPending('ch_A', 'msg_2', 'req_2')
    const { result } = renderHook(() => useChatPermissions('ch_A'))
    act(() => {
      result.current.onDeny('req_2')
    })
    expect(fakeClient.respondToToolPermission).toHaveBeenCalledWith('req_2', false)
    expect(statusOf('msg_2')).toBe('failed')
  })

  it('onGrantAlways responds true and persists the allow rule', async () => {
    const { result } = renderHook(() => useChatPermissions('ch_A'))
    await act(async () => {
      await result.current.onGrantAlways('req_4', 'app_1', 'files-read')
    })
    expect(fakeClient.respondToToolPermission).toHaveBeenCalledWith('req_4', true)
    expect(fakeClient.app.updateToolPermission).toHaveBeenCalledWith('app_1', 'files-read', 'allow')
  })

  it('onDenyAlways responds false and persists the forbid rule', async () => {
    const { result } = renderHook(() => useChatPermissions('ch_A'))
    await act(async () => {
      await result.current.onDenyAlways('req_5', 'app_1', 'files-read')
    })
    expect(fakeClient.respondToToolPermission).toHaveBeenCalledWith('req_5', false)
    expect(fakeClient.app.updateToolPermission).toHaveBeenCalledWith('app_1', 'files-read', 'forbid')
  })

  it('tears down the permission listener on unmount', () => {
    const { unmount } = renderHook(() => useChatPermissions('ch_A'))
    expect(fakeClient.count('tool_permission_request')).toBe(1)
    unmount()
    expect(fakeClient.count('tool_permission_request')).toBe(0)
  })
})
