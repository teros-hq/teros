/**
 * billingStore reducers (FASE 6). Each assertion targets a mutation:
 *   - setWarning must RESET warningDismissed (a fresh 80% nudge resurfaces the
 *     banner even after a prior dismiss) — break the reset and case 2 goes red.
 *   - clearWarning nulls the warning AND un-dismisses.
 *   - inc/reset/dismiss/setLastResolution carry exact state.
 *
 *   cd packages/app && npx vitest run src/store/billingStore.render.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useBillingStore } from './billingStore'

const WARNING = {
  used: 16,
  limit: 20,
  boostHours: 0,
  threshold: 0.8,
  tier: 'pro',
  planName: 'Pro',
  periodEnd: '2026-07-01T00:00:00.000Z',
}

beforeEach(() => {
  useBillingStore.setState({
    warning: null,
    warningDismissed: false,
    pendingAdminRequests: 0,
    lastResolution: null,
  })
})

describe('billingStore', () => {
  it('setWarning stores the payload and clears a prior dismiss', () => {
    useBillingStore.getState().dismissWarning()
    expect(useBillingStore.getState().warningDismissed).toBe(true)

    useBillingStore.getState().setWarning(WARNING)

    const s = useBillingStore.getState()
    expect(s.warning).toEqual(WARNING)
    // The fresh warning must resurface the banner.
    expect(s.warningDismissed).toBe(false)
  })

  it('dismissWarning hides the banner but keeps the warning data', () => {
    useBillingStore.getState().setWarning(WARNING)
    useBillingStore.getState().dismissWarning()

    const s = useBillingStore.getState()
    expect(s.warningDismissed).toBe(true)
    expect(s.warning).toEqual(WARNING)
  })

  it('clearWarning nulls the warning and un-dismisses', () => {
    useBillingStore.getState().setWarning(WARNING)
    useBillingStore.getState().dismissWarning()

    useBillingStore.getState().clearWarning()

    const s = useBillingStore.getState()
    expect(s.warning).toBeNull()
    expect(s.warningDismissed).toBe(false)
  })

  it('pendingAdminRequests increments and resets', () => {
    const { incPendingAdminRequests, resetPendingAdminRequests } = useBillingStore.getState()
    incPendingAdminRequests()
    incPendingAdminRequests()
    expect(useBillingStore.getState().pendingAdminRequests).toBe(2)

    resetPendingAdminRequests()
    expect(useBillingStore.getState().pendingAdminRequests).toBe(0)
  })

  it('setLastResolution carries the exact resolution', () => {
    useBillingStore.getState().setLastResolution({
      requestType: 'boost',
      status: 'approved',
      grantedHours: 10,
    })
    expect(useBillingStore.getState().lastResolution).toEqual({
      requestType: 'boost',
      status: 'approved',
      grantedHours: 10,
    })
  })
})
