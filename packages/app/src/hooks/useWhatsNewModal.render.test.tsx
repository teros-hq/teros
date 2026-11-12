import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../store/authStore'
import { useFeatureFlagsStore } from '../store/featureFlagsStore'
import { useWhatsNewModal } from './useWhatsNewModal'

vi.mock('../services/terosClientSingleton', () => ({ getTerosClient: () => ({ profile: { markChangelogSeen: vi.fn() } }) }))

/** A brand-new user: profile synced, no changelog entry seen yet. */
function signInNewUser() {
  useAuthStore.setState({ user: { userId: 'u1', email: 'a@b.c', name: 'A' } as any, isProfileSynced: true })
}

beforeEach(() => {
  useFeatureFlagsStore.getState().setFlags({})
})

describe('useWhatsNewModal', () => {
  it('[WNEW-AC-1] with the flag at its default (off) the modal never opens and there is no manual re-open', () => {
    signInNewUser()
    const { result } = renderHook(() => useWhatsNewModal())
    expect(result.current.isModalVisible).toBe(false)
    expect(result.current.showWhatsNew).toBeUndefined()
  })

  it('[WNEW-AC-2] with the flag on, a new user gets the modal and the re-open action', () => {
    useFeatureFlagsStore.getState().setFlags({ 'whats-new.enabled': { value: true } as any })
    signInNewUser()
    const { result } = renderHook(() => useWhatsNewModal())
    expect(result.current.isModalVisible).toBe(true)
    expect(typeof result.current.showWhatsNew).toBe('function')
  })
})
