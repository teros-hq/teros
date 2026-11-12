/**
 * Profile domain — registers all profile handlers with the router
 *
 * Actions:
 *   profile.get                  → Get current user profile
 *   profile.update               → Update current user profile
 *   profile.stats                → Get current user's usage statistics (channelCount, agentCount)
 *   profile.accept-terms         → Accept Terms of Service
 *   profile.complete-onboarding  → Mark onboarding wizard as completed
 *   profile.onboarding-status    → Get real-time onboarding checklist status
 *   profile.mark-changelog-seen  → Mark the last changelog entry the user has seen
 *   profile.set-evaluation-consent → Opt-in toggle for anonymized conversation evaluation
 *   profile.delete-account       → Erase the account (GDPR), re-authenticated
 */

import { UserService } from '../../../auth/user-service'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import { createGetProfileHandler } from './get'
import { createUpdateProfileHandler } from './update'
import { createAcceptTermsHandler } from './accept-terms'
import { createGetProfileStatsHandler } from './stats'
import { createCompleteOnboardingHandler } from './complete-onboarding'
import { createOnboardingStatusHandler } from './onboarding-status'
import { createMarkChangelogSeenHandler } from './mark-changelog-seen'
import { createSetEvaluationConsentHandler } from './consent'
import { createDeleteAccountHandler } from './delete-account'

interface ProfileDeps {
  db: Db
  userService?: UserService | null
}

export function register(router: WsRouter, deps: ProfileDeps): void {
  const userService = deps.userService ?? new UserService(deps.db)

  router.register('profile.get', createGetProfileHandler(userService))
  router.register('profile.update', createUpdateProfileHandler(userService))
  router.register('profile.accept-terms', createAcceptTermsHandler(userService))
  router.register('profile.stats', createGetProfileStatsHandler(deps.db))
  router.register('profile.complete-onboarding', createCompleteOnboardingHandler(userService))
  router.register('profile.onboarding-status', createOnboardingStatusHandler(deps.db, userService))
  router.register('profile.mark-changelog-seen', createMarkChangelogSeenHandler(userService))
  router.register('profile.set-evaluation-consent', createSetEvaluationConsentHandler(userService))
  router.register('profile.delete-account', createDeleteAccountHandler(deps.db, userService))
}
