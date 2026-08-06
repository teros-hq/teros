import { describe, expect, it } from 'vitest'
import { shouldRedirectToOnboarding } from './onboarding-redirect'

const BASE = {
  isProfileSynced: true,
  isImpersonating: false,
  accessGranted: true,
  termsAcceptedAt: '2026-01-01',
  onboardingCompletedAt: undefined,
}

describe('shouldRedirectToOnboarding', () => {
  it('redirects a synced, access-granted, terms-accepted, not-onboarded user', () => {
    expect(shouldRedirectToOnboarding(BASE)).toBe(true)
  })

  it('does NOT redirect while impersonating (M4: `user` is the target)', () => {
    // MUST BITE: dropping the isImpersonating guard bounces an admin who is
    // impersonating a not-onboarded user into the target's onboarding wizard.
    expect(shouldRedirectToOnboarding({ ...BASE, isImpersonating: true })).toBe(false)
  })

  it('does NOT redirect before the profile sync completes', () => {
    expect(shouldRedirectToOnboarding({ ...BASE, isProfileSynced: false })).toBe(false)
  })

  it('does NOT redirect a user who already completed onboarding', () => {
    expect(
      shouldRedirectToOnboarding({ ...BASE, onboardingCompletedAt: '2026-02-01' }),
    ).toBe(false)
  })

  it('does NOT redirect without platform access or terms', () => {
    expect(shouldRedirectToOnboarding({ ...BASE, accessGranted: false })).toBe(false)
    expect(shouldRedirectToOnboarding({ ...BASE, termsAcceptedAt: null })).toBe(false)
  })
})
