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
  const agents = db.collection('agents')
  // Live messages are in channel_messages (`messages` is the legacy collection — MOD-1)
  const messages = db.collection('channel_messages')

  return async function onboardingStatus(ctx: WsHandlerContext): Promise<OnboardingStatus> {
    // agent_app_access has no ownerId: resolve the user's agents first (MOD-1)
    const ownAgentIds = (
      await agents.find({ ownerId: ctx.userId }).project<{ agentId: string }>({ agentId: 1, _id: 0 }).toArray()
    ).map((a) => a.agentId)

    const [user, providerCount, credentialCount, accessCount, messageCount] = await Promise.all([
      userService.getByUserId(ctx.userId),
      providers.countDocuments({ userId: ctx.userId, status: 'active' }, { limit: 1 }),
      credentials.countDocuments({ userId: ctx.userId }, { limit: 1 }),
      // apps assigned to any agent this user owns
      ownAgentIds.length > 0
        ? agentAppAccess.countDocuments({ agentId: { $in: ownAgentIds } }, { limit: 1 })
        : Promise.resolve(0),
      // messages sent by the user (role: 'user') in any channel
      messages.countDocuments({ userId: ctx.userId, role: 'user' }, { limit: 1 }),
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
