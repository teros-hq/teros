/**
 * useChatChannel — WS listener lifecycle (TER-451).
 *
 * The hook registers 13 listeners on the WS client and MUST tear all of them down
 * in the effect cleanup. `channel_private_updated` (since renamed
 * `channel_scope_updated`, a6583cc6c) was registered but never `off()`'d, so it
 * leaked: a fresh handler accumulated on every reconnect / channel change and the
 * handler fired N times (the TER-369 class of bug). These tests count listeners per
 * event with a faithful fake client (the real client is an EventEmitter) and assert
 * the balance on mount, unmount, and re-run — both for the known event list and for
 * every event the hook actually registered, so a new listener can't escape the net.
 *
 *   cd packages/app && npx vitest run src/hooks/chat/useChatChannel.render.test.ts
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Faithful fake of the Teros WS client: on()/off() mutate a per-event handler set,
// exactly like the EventEmitter the real client extends. The async surface the hook
// may touch while mounting is stubbed so it never throws.
class FakeClient {
  private listeners = new Map<string, Set<(...a: unknown[]) => void>>()
  on(event: string, handler: (...a: unknown[]) => void): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
  }
  off(event: string, handler: (...a: unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler)
  }
  count(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
  events(): string[] {
    return [...this.listeners.keys()]
  }
  isConnected = () => false
  channel = {
    get: vi.fn(async () => ({ id: 'ch', agentId: undefined, isPrivate: false })),
    subscribe: vi.fn(async () => ({ ok: true })),
    getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
  }
  agent = { listAgents: vi.fn(async () => ({ agents: [] })) }
  workspace = { listWorkspaces: vi.fn(async () => ({ workspaces: [] })) }
}

const hoisted = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => hoisted.client,
}))

import { useChatChannel } from './useChatChannel'

// The 13 listeners registered by the main "Message Listeners" effect.
// `token_budget` is no longer one of them: 81fbbab5c moved the budget feed
// behind the admin-only View Token Usage gate, out of this hook.
const WS_EVENTS = [
  'message',
  'message_chunk',
  'message_sent',
  'queue_state',
  'agent_phase',
  'typing',
  'system_event',
  'channel_status',
  'channel_scope_updated',
  'conversation.message.feedback.created',
  'conversation.message.action.executed',
  'message_redacted',
  'error',
] as const

let fakeClient: FakeClient

function mount(channelId: string | undefined) {
  return renderHook(({ id }) => useChatChannel(id, undefined, undefined, undefined, []), {
    initialProps: { id: channelId },
  })
}

describe('useChatChannel — WS listener lifecycle (TER-451)', () => {
  beforeEach(() => {
    fakeClient = new FakeClient()
    hoisted.client = fakeClient
  })

  it('registers exactly one of each channel listener on mount', () => {
    mount('ch_1')
    for (const ev of WS_EVENTS) {
      expect(fakeClient.count(ev)).toBe(1)
    }
    for (const ev of fakeClient.events()) {
      expect(fakeClient.count(ev), ev).toBeLessThanOrEqual(1)
    }
  })

  it('tears down EVERY listener on unmount — no orphan (regression: channel_private_updated → channel_scope_updated)', () => {
    const { unmount } = mount('ch_1')
    unmount()
    for (const ev of fakeClient.events()) {
      expect(fakeClient.count(ev), ev).toBe(0)
    }
    // The historical leak: this one stayed registered. Explicit guard.
    expect(fakeClient.count('channel_scope_updated')).toBe(0)
  })

  it('does not accumulate listeners across channel changes (reconnect/resume)', () => {
    const { rerender } = mount('ch_1')
    rerender({ id: 'ch_2' }) // channelId change → effect cleanup + re-run
    rerender({ id: 'ch_3' })
    // With the leak, channel_scope_updated would be 3 (one per run, never removed).
    for (const ev of WS_EVENTS) {
      expect(fakeClient.count(ev)).toBe(1)
    }
    for (const ev of fakeClient.events()) {
      expect(fakeClient.count(ev), ev).toBeLessThanOrEqual(1)
    }
  })
})
