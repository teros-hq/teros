/**
 * channel.unsubscribe — Unsubscribe the current session from a channel
 */

import type { WsHandlerContext } from '@teros/shared'
import type { PubSubService } from '../../../services/pubsub-service'

interface UnsubscribeChannelData {
  channelId: string
}

export function createUnsubscribeChannelHandler(pubSubService: PubSubService) {
  return async function unsubscribeChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UnsubscribeChannelData

    pubSubService.unsubscribeSession(ctx.sessionId, `channel:${data.channelId}`)

    return { channelId: data.channelId }
  }
}
