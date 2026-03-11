/**
 * channel.mark-read — Mark a channel as read for the current user
 */

import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'

interface MarkChannelReadData {
  channelId: string
}

export function createMarkReadHandler(channelManager: ChannelManager) {
  return async function markChannelRead(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as MarkChannelReadData

    await channelManager.markChannelAsRead(data.channelId, ctx.userId)

    return { channelId: data.channelId }
  }
}
