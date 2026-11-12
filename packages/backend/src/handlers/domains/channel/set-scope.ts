/**
 * channel.set-scope — Toggle channel scope between 'personal' and 'shared' (REQ-2).
 *
 * Authorization: canToggleScope (only the channel creator).
 * Non-creator → ACCESS_DENIED ("You do not have permission to perform this action").
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import { channelListScope } from '@teros/shared'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import { canToggleScope } from '../../../auth/channel-permissions'

interface SetScopeData {
  channelId: string
  scope: 'personal' | 'shared'
}

export function createSetScopeHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
  pubSubService: PubSubService,
  db: Db,
) {
  return async function setScope(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetScopeData

    if (!data.channelId) {
      throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    }
    if (data.scope !== 'personal' && data.scope !== 'shared') {
      throw new HandlerError('INVALID_SCOPE', `scope must be 'personal' or 'shared', got: ${data.scope}`)
    }

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    // Authorization: only the channel creator can toggle scope (REQ-2, REQ-10)
    const allowed = await canToggleScope(db, ctx.userId, data.channelId)
    if (!allowed) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have permission to perform this action')
    }

    await channelManager.setChannelScope(data.channelId, data.scope)

    // Broadcast channel_status to channel subscribers
    pubSubService.broadcastToTopic(`channel:${data.channelId}`, {
      type: 'channel_status',
      channelId: data.channelId,
      scope: data.scope,
    })

    // Notify all user sessions about the scope change
    // When a channel becomes shared, other members' lists should refresh
    // When it becomes personal, other members should see it removed
    const sessions = sessionManager.getUserSessions(ctx.userId)
    const listStatusMsg = JSON.stringify({
      type: 'channel_list_status',
      channelId: data.channelId,
      action: data.scope === 'shared' ? 'updated' : 'updated',
      channel: {
        channelId: data.channelId,
        scope: data.scope,
        ...channelListScope(channel),
      },
    })
    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(listStatusMsg)
      }
    }

    return { channelId: data.channelId, scope: data.scope }
  }
}
