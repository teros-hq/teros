/**
 * useChatInput.handleArchive — regression for the "archive does nothing" bug.
 *
 * handleArchive shipped as a stub (`console.log("Archive not implemented yet")`),
 * so the "Archive conversation" action in the chat header never called
 * channel.close. The channel stayed `active` in Mongo, so it never left the
 * NavBar / Conversations list — not even on reload (channel.list kept returning
 * it as active). These tests bite: they pin the EXACT channel.close(channelId)
 * call and the onArchived ordering, plus the boundaries (no channelId → no-op;
 * close rejects → window must NOT close so the chat isn't lost).
 *
 *   cd packages/app && npx vitest run src/hooks/chat/useChatInput.render.test.ts
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Faithful-enough fake of the Teros WS client: only the surface handleArchive
// touches (channel.close). Returns the real backend shape { channelId, status }.
class FakeClient {
  isConnected = () => false
  channel = {
    close: vi.fn(async (channelId: string) => ({ channelId, status: 'closed' as const })),
  }
}

const hoisted = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => hoisted.client,
}))
// The hook reads activeWorkspaceId at render; stub the selector so no real store spins up.
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: (sel: (s: { activeWorkspaceId: string | undefined }) => unknown) =>
    sel({ activeWorkspaceId: undefined }),
}))

import { useChatInput } from './useChatInput'

let fakeClient: FakeClient

// All UseChatInputOptions fields are `| undefined`; only channelId/onArchived matter here.
function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'ch_default',
    initialAgentId: undefined,
    workspaceId: undefined,
    conversation: undefined,
    onChannelCreated: undefined,
    onTitleChange: undefined,
    setModelString: () => {},
    setModelName: () => {},
    setProviderName: () => {},
    setConversation: () => {},
    onArchived: undefined,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('useChatInput.handleArchive (regression: archive was a stub)', () => {
  beforeEach(() => {
    fakeClient = new FakeClient()
    hoisted.client = fakeClient
  })

  it('archives via channel.close(channelId), then calls onArchived to close the window', async () => {
    const onArchived = vi.fn()
    const { result } = renderHook(() =>
      useChatInput(makeOptions({ channelId: 'ch_abc', onArchived })),
    )

    await act(async () => {
      await result.current.handleArchive()
    })

    // The exact wire call — a stub (console.log) would make this zero.
    expect(fakeClient.channel.close).toHaveBeenCalledTimes(1)
    expect(fakeClient.channel.close).toHaveBeenCalledWith('ch_abc')
    // Window closes only after the backend confirmed the archive.
    expect(onArchived).toHaveBeenCalledTimes(1)
    expect(fakeClient.channel.close.mock.invocationCallOrder[0]).toBeLessThan(
      onArchived.mock.invocationCallOrder[0],
    )
  })

  it('is a no-op with no channelId — a brand-new unsent chat has no channel to archive', async () => {
    const onArchived = vi.fn()
    const { result } = renderHook(() =>
      useChatInput(makeOptions({ channelId: undefined, onArchived })),
    )

    await act(async () => {
      await result.current.handleArchive()
    })

    expect(fakeClient.channel.close).not.toHaveBeenCalled()
    expect(onArchived).not.toHaveBeenCalled()
  })

  it('does NOT close the window when channel.close fails — the chat must survive a failed archive', async () => {
    fakeClient.channel.close.mockRejectedValueOnce(new Error('UNAUTHORIZED'))
    const onArchived = vi.fn()
    const { result } = renderHook(() =>
      useChatInput(makeOptions({ channelId: 'ch_x', onArchived })),
    )

    // Swallows the error (no throw) but leaves the window open.
    await act(async () => {
      await expect(result.current.handleArchive()).resolves.toBeUndefined()
    })

    expect(fakeClient.channel.close).toHaveBeenCalledWith('ch_x')
    expect(onArchived).not.toHaveBeenCalled()
  })
})
