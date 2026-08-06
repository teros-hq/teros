import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveRetention } from '@teros/shared'
import { useRetentionAckStore } from '../../store/retentionAckStore'
import { useRetentionGuard } from './useRetentionGuard'

/**
 * The guard makes a non-ZDR choice conscious: for 🟡 (retains) and 🔴 (trains)
 * it opens the modal and defers the action, runs the action on confirm, and
 * REMEMBERS the (key, tier) so it never re-prompts for the same posture — but
 * DOES re-prompt if the posture worsens. Only 🟢 ZDR passes through untouched.
 */
beforeEach(() => {
  useRetentionAckStore.getState().reset()
})

describe('useRetentionGuard', () => {
  it('opens the modal and defers proceed for a 🔴 model', () => {
    const proceed = vi.fn()
    const { result } = renderHook(() => useRetentionGuard())
    act(() => {
      result.current.guard(resolveRetention('anthropic-oauth'), 'claude', 'Claude Pro/Max', proceed)
    })
    expect(result.current.modalProps.open).toBe(true)
    expect(result.current.modalProps.modelName).toBe('Claude Pro/Max')
    expect(proceed).not.toHaveBeenCalled()
  })

  it('confirm proceeds, remembers the (key, tier), and never re-prompts', () => {
    const { result } = renderHook(() => useRetentionGuard())
    const proceed1 = vi.fn()
    act(() => {
      result.current.guard(resolveRetention('anthropic-oauth'), 'claude', 'Claude', proceed1)
    })
    act(() => result.current.modalProps.onConfirm())
    expect(proceed1).toHaveBeenCalledTimes(1)
    expect(result.current.modalProps.open).toBe(false)
    // Stored under the tier-composed key, not the bare key.
    expect(useRetentionAckStore.getState().isAcked('claude:trains')).toBe(true)
    expect(useRetentionAckStore.getState().isAcked('claude')).toBe(false)

    // Same key + same tier → no modal, runs immediately.
    const proceed2 = vi.fn()
    act(() => {
      result.current.guard(resolveRetention('anthropic-oauth'), 'claude', 'Claude', proceed2)
    })
    expect(proceed2).toHaveBeenCalledTimes(1)
    expect(result.current.modalProps.open).toBe(false)
  })

  it('re-prompts when the posture WORSENS for the same key (🟡 acked → 🔴)', () => {
    const { result } = renderHook(() => useRetentionGuard())
    // Acknowledge zhipu at the z.ai (🟡 retains) endpoint.
    act(() => result.current.guard(resolveRetention('zhipu'), 'zh', 'Z.ai', vi.fn()))
    act(() => result.current.modalProps.onConfirm())
    expect(result.current.modalProps.open).toBe(false)

    // Same key, now routed to China (🔴 trains) → must re-prompt, not ride the ack.
    const proceed = vi.fn()
    act(() => result.current.guard(resolveRetention('zhipu', { useChina: true }), 'zh', 'Z.ai', proceed))
    expect(result.current.modalProps.open).toBe(true)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('cancel aborts without proceeding or remembering', () => {
    const { result } = renderHook(() => useRetentionGuard())
    const proceed = vi.fn()
    act(() => {
      result.current.guard(resolveRetention('minimax'), 'mm', 'MiniMax', proceed)
    })
    expect(result.current.modalProps.open).toBe(true)
    act(() => result.current.modalProps.onCancel())
    expect(proceed).not.toHaveBeenCalled()
    expect(result.current.modalProps.open).toBe(false)
    expect(useRetentionAckStore.getState().isAcked('mm:trains')).toBe(false)
  })

  it('opens the modal for 🟡 (retains) too — e.g. z.ai / paid APIs', () => {
    const { result } = renderHook(() => useRetentionGuard())
    const proceed = vi.fn()
    act(() => result.current.guard(resolveRetention('zhipu'), 'zai', 'Z.ai', proceed)) // 🟡
    expect(result.current.modalProps.open).toBe(true)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('proceeds immediately for 🟢 ZDR without a modal', () => {
    const { result } = renderHook(() => useRetentionGuard())
    const pZdr = vi.fn()
    act(() => result.current.guard(resolveRetention('teros'), 't', 'T', pZdr)) // 🟢
    expect(pZdr).toHaveBeenCalledTimes(1)
    expect(result.current.modalProps.open).toBe(false)
  })

  it('proceeds immediately (no modal) when info is null/undefined', () => {
    // A caller that passes a missing retention (e.g. ModelData.retention is
    // optional) must not silently swallow the action — it just skips the modal.
    const { result } = renderHook(() => useRetentionGuard())
    const proceed = vi.fn()
    act(() => result.current.guard(null, 'k', 'M', proceed))
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(result.current.modalProps.open).toBe(false)
  })
})
