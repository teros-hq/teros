/**
 * channel.unsubscribe — Unsubscribe the current session from a channel
 */

import type { WsHandlerContext } from '@teros/shared'
import type { SessionManager } from '../../../services/session-manager'

interface UnsubscribeChannelData {
  channelId: string
}

export function createUnsubscribeChannelHandler(sessionManager: SessionManager) {
  return async function unsubscribeChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UnsubscribeChannelData

    sessionManager.unsubscribeFromChannel(ctx.sessionId, data.channelId)

    return { channelId: data.channelId }
  }
}
