/**
 * Cross-workspace conversation guard (follow-up of the guard in tilingStore).
 *
 * `openWindow('chat', { channelId })` must NOT open a window for a channel that
 * belongs to a different workspace than the active one. The guard lives at the
 * single chokepoint every conversation-opening path goes through
 * (`tilingStore.openWindow`), and works in two modes:
 *
 *   - Cache HIT  (`_setChannelWorkspace` pre-populated): synchronous check —
 *     returns null and no window is created when the workspace mismatches.
 *   - Cache MISS: the synchronous call returns null and fires an async
 *     verification (`client.channel.get`); if the channel turns out to belong
 *     to the active workspace, the window is re-opened asynchronously.
 *
 * Channels with no workspaceId (superagent channels) are always allowed.
 *
 * Lives under `.render.test.ts` so the vitest render harness picks it up
 * (importing the store pulls react-native via services/storage, which the
 * harness shims). Nothing is rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelApi } from '../../services/ChannelApi'
import { type WindowTypeDefinition, windowRegistry } from '../../services/windowRegistry'
import {
  _clearChannelWorkspaceCache,
  _setChannelWorkspace,
  useTilingStore,
} from '../tilingStore'
import { useWorkspaceStore } from '../workspaceStore'

// The guard keys on the literal window type "chat" — register a minimal fake
// under that exact type so openWindow passes the registry guards and reaches
// the workspace guard.
const CHAT_TYPE = 'chat'

const fakeChatDefinition: WindowTypeDefinition = {
  type: CHAT_TYPE,
  audience: 'user',
  displayName: 'Chat (test)',
  icon: (() => null) as unknown as WindowTypeDefinition['icon'],
  color: '#000000',
  getTitle: () => 'Chat (test)',
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition['component'],
  serialize: (props) => props,
  deserialize: (data) => data,
}

const WORKSPACE_A = 'work_aaa'
const WORKSPACE_B = 'work_bbb'

function setActiveWorkspace(workspaceId: string | null) {
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId })
}

function chatWindowCount(): number {
  return Object.values(useTilingStore.getState().windows).filter((w) => w.type === CHAT_TYPE).length
}

beforeEach(() => {
  windowRegistry.register(fakeChatDefinition)
  _clearChannelWorkspaceCache()
  useTilingStore.getState().resetState()
  setActiveWorkspace(WORKSPACE_A)
})

afterEach(() => {
  windowRegistry.unregister(CHAT_TYPE)
  _clearChannelWorkspaceCache()
  useTilingStore.getState().resetState()
  setActiveWorkspace(null)
  vi.restoreAllMocks()
})

describe('cross-workspace conversation guard (tilingStore.openWindow)', () => {
  it('(a) blocks a channel from another workspace: returns null and opens nothing', () => {
    _setChannelWorkspace('ch_other', WORKSPACE_B)

    const result = useTilingStore.getState().openWindow(CHAT_TYPE, { channelId: 'ch_other' })

    expect(result).toBeNull()
    expect(chatWindowCount()).toBe(0)
  })

  it('(b) opens a channel from the active workspace (cache hit, synchronous)', () => {
    _setChannelWorkspace('ch_mine', WORKSPACE_A)

    const result = useTilingStore.getState().openWindow(CHAT_TYPE, { channelId: 'ch_mine' })

    expect(result).not.toBeNull()
    expect(chatWindowCount()).toBe(1)
  })

  it('(c) allows a channel with no workspaceId (superagent channel)', () => {
    _setChannelWorkspace('ch_super', null)

    const result = useTilingStore.getState().openWindow(CHAT_TYPE, { channelId: 'ch_super' })

    expect(result).not.toBeNull()
    expect(chatWindowCount()).toBe(1)
  })

  it('(d) cache miss: blocks synchronously, verifies async, then re-opens if workspace matches', async () => {
    // No cache entry for ch_async — the guard must take the async path.
    const getSpy = vi
      .spyOn(ChannelApi.prototype, 'get')
      .mockResolvedValue({ channelId: 'ch_async', agentId: 'agent_x', workspaceId: WORKSPACE_A })

    // Synchronous call: blocked for now (returns null, no window yet).
    const result = useTilingStore.getState().openWindow(CHAT_TYPE, { channelId: 'ch_async' })
    expect(result).toBeNull()
    expect(chatWindowCount()).toBe(0)

    // Async verification resolves → channel belongs to the active workspace →
    // the guard re-opens the window (this time with a cache hit).
    await vi.waitFor(() => {
      expect(chatWindowCount()).toBe(1)
    })
    expect(getSpy).toHaveBeenCalledWith('ch_async')

    // The result was cached: a second open is now a synchronous cache hit and
    // does not call the backend again.
    getSpy.mockClear()
    const second = useTilingStore.getState().openWindow(CHAT_TYPE, { channelId: 'ch_async' }, true)
    expect(second).not.toBeNull()
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('(d2) cache miss on a foreign-workspace channel: verifies async and never opens', async () => {
    vi.spyOn(ChannelApi.prototype, 'get').mockResolvedValue({
      channelId: 'ch_foreign',
      agentId: 'agent_x',
      workspaceId: WORKSPACE_B,
    })

    const result = useTilingStore.getState().openWindow(CHAT_TYPE, { channelId: 'ch_foreign' })
    expect(result).toBeNull()
    expect(chatWindowCount()).toBe(0)

    // Give the async verification a chance to resolve — the window must NOT appear.
    await new Promise((r) => setTimeout(r, 50))
    expect(chatWindowCount()).toBe(0)
  })
})
