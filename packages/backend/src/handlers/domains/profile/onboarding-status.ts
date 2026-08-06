/**
 * profile.onboarding-status — Get real-time onboarding checklist status
 *
 * Returns a snapshot of which onboarding steps the user has completed.
 * All values are computed in real-time from the database — nothing is cached.
 *
 * Used by the GettingStartedWidget in the Navbar.
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'

interface OnboardingStatus {
  /** User has ≥1 active LLM provider */
  hasProvider: boolean
  /** User has completed the onboarding wizard (onboardingCompletedAt is set) */
  hasOnboardingCompleted: boolean
  /** User has ≥1 installed app with credentials configured (user_credentials) */
  hasAppWithCredentials: boolean
  /** User has ≥1 app assigned to any of their agents (agent_app_access) */
  hasAppAssigned: boolean
  /** User has sent ≥1 message (role: user) in any channel */
  hasFirstMessage: boolean
}

export function createOnboardingStatusHandler(db: Db, userService: UserService) {
  const providers = db.collection('user_providers')
  const credentials = db.collection('user_credentials')
  const agentAppAccess = db.collection('agent_app_access')
  const messages = db.collection('messages')

  return async function onboardingStatus(ctx: WsHandlerContext): Promise<OnboardingStatus> {
    const [user, providerCount, credentialCount, accessCount, messageCount] = await Promise.all([
      userService.getByUserId(ctx.userId),
      providers.countDocuments({ userId: ctx.userId, status: 'active' }),
      credentials.countDocuments({ userId: ctx.userId }),
      // agent_app_access: check agents owned by this user
      agentAppAccess.countDocuments({ ownerId: ctx.userId }),
      // messages sent by the user (role: 'user') in any channel they own
      messages.countDocuments({ userId: ctx.userId, role: 'user' }),
    ])

    return {
      hasProvider: providerCount > 0,
      hasOnboardingCompleted: !!user?.onboardingCompletedAt,
      hasAppWithCredentials: credentialCount > 0,
      hasAppAssigned: accessCount > 0,
      hasFirstMessage: messageCount > 0,
    }
  }
}
