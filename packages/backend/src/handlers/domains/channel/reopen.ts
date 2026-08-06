/**
 * channel.reopen — Reopen a previously closed channel
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'

interface ReopenChannelData {
  channelId: string
}

export function createReopenChannelHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
) {
  return async function reopenChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ReopenChannelData

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      throw new HandlerError('UNAUTHORIZED', 'Access denied')
    }

    await channelManager.reopenChannel(data.channelId)

    // Re-fetch + enrich so the reopened channel arrives in the conversation
    // list with full agent identity, not a bare {channelId, status} payload.
    const reopened = await channelManager.getChannel(data.channelId)
    const channelData = await channelManager.enrichChannel({
      channelId: reopened!.channelId,
      agentId: reopened!.agentId,
      title: reopened!.metadata?.name || 'Nuevo chat',
      status: reopened!.status,
      createdAt: reopened!.createdAt,
      updatedAt: reopened!.updatedAt,
      workspaceId: reopened!.workspaceId,
    })

    // Broadcast to all user sessions (treat reopen as created for the list)
    const sessions = sessionManager.getUserSessions(ctx.userId)
    const broadcastMsg = JSON.stringify({
      type: 'channel_list_status',
      channelId: data.channelId,
      action: 'created',
      channel: channelData,
    })
    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(broadcastMsg)
      }
    }

    return { channelId: data.channelId, status: 'active' }
  }
}
