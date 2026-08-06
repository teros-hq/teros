/**
 * channel.get — Get a single channel by ID, enriched with agent info
 *
 * Returns the channel in the same flat format as channel.list entries,
 * so the frontend can use it interchangeably without special-casing.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'

interface GetChannelData {
  channelId: string
}

export function createGetChannelHandler(channelManager: ChannelManager) {
  return async function getChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetChannelData

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      throw new HandlerError('UNAUTHORIZED', 'Access denied')
    }

    const channel = await channelManager.getEnrichedChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    return channel
  }
}
