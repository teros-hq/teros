/**
 * channel.search — Search message content across all user channels
 */

import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'

interface SearchConversationsData {
  query: string
  limit?: number
}

export function createSearchChannelsHandler(channelManager: ChannelManager) {
  return async function searchChannels(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SearchConversationsData
    const { query, limit } = data

    console.log(`[channel.search] Searching for user ${ctx.userId}: "${query}"`)

    const { results, totalMatches } = await channelManager.searchMessages(
      ctx.userId,
      query,
      limit || 50,
    )

    console.log(`[channel.search] ${totalMatches} matches in ${results.length} channels`)

    return { query, results, totalMatches }
  }
}
