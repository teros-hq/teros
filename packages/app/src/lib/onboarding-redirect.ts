/**
 * Pure predicate for the onboarding redirect guard (TER-596 I2). Extracted from
 * `app/(workspace)/_layout.tsx` so it can be unit-tested without mounting the
 * whole workspace tree.
 *
 * Returns true when the signed-in user should be sent to the onboarding wizard.
 * Critically, it returns false while impersonating: `user` is then the TARGET,
 * and startImpersonation does not reset isProfileSynced — without this guard an
 * admin impersonating a not-onboarded user would be bounced into the target's
 * wizard (change-of-meaning of `user`, review finding M4).
 */
export interface OnboardingGuardState {
  isProfileSynced: boolean
  isImpersonating: boolean
  accessGranted: boolean | undefined
  termsAcceptedAt: unknown
  onboardingCompletedAt: unknown
}

export function shouldRedirectToOnboarding(s: OnboardingGuardState): boolean {
  if (s.isImpersonating) return false
  return (
    s.isProfileSynced &&
    !!s.accessGranted &&
    !!s.termsAcceptedAt &&
    !s.onboardingCompletedAt
  )
}
