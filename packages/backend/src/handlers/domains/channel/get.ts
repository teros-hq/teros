/**
 * channel.get — Get full details of a channel
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

    const details = await channelManager.getChannelDetails(data.channelId)
    if (!details) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      throw new HandlerError('UNAUTHORIZED', 'Access denied')
    }

    return details
  }
}
