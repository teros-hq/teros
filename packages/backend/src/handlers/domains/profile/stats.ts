/**
 * profile.stats — Get current user's usage statistics
 *
 * Returns:
 *   - channelCount: total number of conversations owned by the user
 *   - agentCount: total number of agents owned by the user (global, no workspace)
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'

interface ProfileStats {
  channelCount: number
  agentCount: number
}

export function createGetProfileStatsHandler(db: Db) {
  const channels = db.collection('channels')
  const agents = db.collection('agents')

  return async function getProfileStats(ctx: WsHandlerContext): Promise<ProfileStats> {
    const [channelCount, agentCount] = await Promise.all([
      // Count all channels owned by the user (global + workspace)
      channels.countDocuments({ userId: ctx.userId }),
      // Count all agents owned by the user (global agents only, workspaces excluded)
      agents.countDocuments({ ownerId: ctx.userId }),
    ])

    return { channelCount, agentCount }
  }
}
