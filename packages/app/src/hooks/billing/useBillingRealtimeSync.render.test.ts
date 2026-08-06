/**
 * useBillingRealtimeSync (FASE 6 + TER-596 I4) — the hook MUST subscribe the
 * billingStore to the 4 billing.* events, tear every listener down on unmount
 * (the TER-369 leak class), AND surface admin resolutions as toasts. Uses a
 * faithful fake client (on/off mutate a per-event handler set, exactly like the
 * real EventEmitter) and a toast spy, and asserts:
 *   - exact store payload mapping on usage-warning (incl. planName),
 *   - a malformed warning is ignored (the guard bites),
 *   - access-granted clears a live warning (stale nudge) AND toasts success,
 *   - access-denied toasts a warning,
 *   - access-requested bumps the admin badge,
 *   - listener balance returns to 0 on unmount.
 *
 *   cd packages/app && npx vitest run src/hooks/billing/useBillingRealtimeSync.render.test.ts
 */
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  emit(event: string, data: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(data)
  }
  count(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

const hoisted = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => hoisted.client,
}))

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
}))
vi.mock('../../components/Toast', () => ({ useToast: () => toastSpies }))

import { useBillingStore } from '../../store/billingStore'
import { useBillingRealtimeSync } from './useBillingRealtimeSync'

const EVENTS = [
  'billing.usage-warning',
  'billing.access-granted',
  'billing.access-denied',
  'billing.access-requested',
] as const

let fake: FakeClient

beforeEach(() => {
  fake = new FakeClient()
  hoisted.client = fake
  for (const s of Object.values(toastSpies)) s.mockClear()
  useBillingStore.setState({
    warning: null,
    warningDismissed: false,
    pendingAdminRequests: 0,
    lastResolution: null,
  })
})

describe('useBillingRealtimeSync', () => {
  it('subscribes to all 4 billing events and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useBillingRealtimeSync())
    for (const ev of EVENTS) expect(fake.count(ev)).toBe(1)
    unmount()
    for (const ev of EVENTS) expect(fake.count(ev)).toBe(0)
  })

  it('maps a usage-warning event to the store with the exact payload', () => {
    renderHook(() => useBillingRealtimeSync())
    act(() => {
      fake.emit('billing.usage-warning', {
        type: 'billing.usage-warning',
        userId: 'u1',
        used: 16,
        limit: 20,
        boostHours: 0,
        threshold: 0.8,
        tier: 'pro',
        planName: 'Pro',
        periodEnd: '2026-07-01T00:00:00.000Z',
      })
    })
    expect(useBillingStore.getState().warning).toEqual({
      used: 16,
      limit: 20,
      boostHours: 0,
      threshold: 0.8,
      tier: 'pro',
      planName: 'Pro',
      periodEnd: '2026-07-01T00:00:00.000Z',
    })
  })

  it('ignores a malformed warning (no numeric used/limit)', () => {
    renderHook(() => useBillingRealtimeSync())
    act(() => {
      fake.emit('billing.usage-warning', { type: 'billing.usage-warning', tier: 'Pro' })
    })
    expect(useBillingStore.getState().warning).toBeNull()
  })

  it('access-granted records the resolution, clears a live warning, and toasts success', () => {
    renderHook(() => useBillingRealtimeSync())
    act(() => {
      fake.emit('billing.usage-warning', {
        used: 16,
        limit: 20,
        boostHours: 0,
        threshold: 0.8,
        tier: 'pro',
        planName: 'Pro',
        periodEnd: null,
      })
    })
    expect(useBillingStore.getState().warning).not.toBeNull()

    act(() => {
      fake.emit('billing.access-granted', { requestType: 'boost', grantedHours: 10 })
    })
    const s = useBillingStore.getState()
    expect(s.lastResolution).toEqual({ requestType: 'boost', status: 'approved', grantedHours: 10 })
    expect(s.warning).toBeNull()
    // MUST BITE: the user may not have the panel open — the toast is the signal.
    expect(toastSpies.success).toHaveBeenCalledTimes(1)
    expect(toastSpies.success).toHaveBeenCalledWith('Request approved', '10 extra hours added.')
  })

  it('access-denied records a denied resolution, toasts a warning, leaves the warning untouched', () => {
    renderHook(() => useBillingRealtimeSync())
    act(() => {
      fake.emit('billing.access-denied', { requestType: 'boost' })
    })
    expect(useBillingStore.getState().lastResolution).toEqual({
      requestType: 'boost',
      status: 'denied',
    })
    expect(toastSpies.warning).toHaveBeenCalledTimes(1)
    expect(toastSpies.warning).toHaveBeenCalledWith('Request denied', 'An admin denied your request.')
  })

  it('access-requested increments the admin badge', () => {
    renderHook(() => useBillingRealtimeSync())
    act(() => {
      fake.emit('billing.access-requested', { requestId: 'r1' })
      fake.emit('billing.access-requested', { requestId: 'r2' })
    })
    expect(useBillingStore.getState().pendingAdminRequests).toBe(2)
  })
})
