/**
 * channel.create-with-message — Create a channel and send the first message atomically
 *
 * Simplifies the frontend by avoiding race conditions when starting new conversations.
 *
 * NOTE: This handler needs access to the raw WebSocket to call messageHandler.handleSendMessage.
 * The WsHandlerContext is extended with an optional `ws` field that the WsRouter populates
 * when dispatching. The index.ts registers this via a wrapper that injects ws from the
 * dispatch call in websocket-handler.ts.
 */

import type { WebSocket } from 'ws'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { MessageHandler } from '../../message-handler'

interface CreateWithMessageData {
  agentId: string
  content: any
  metadata?: Record<string, any>
  workspaceId?: string
}

export interface CreateWithMessageDeps {
  channelManager: ChannelManager
  sessionManager: SessionManager
  messageHandler: MessageHandler
  /** Returns the sessionId for the given WebSocket connection */
  getSessionId: (ws: WebSocket) => string | undefined
}

/**
 * Returns a handler factory that requires ws to be passed at call time.
 * Used by the domain index to register a WsHandler-compatible wrapper.
 */
export function createCreateWithMessageHandler(deps: CreateWithMessageDeps) {
  const { channelManager, sessionManager, messageHandler, getSessionId } = deps

  return async function createChannelWithMessage(
    ctx: WsHandlerContext & { ws: WebSocket },
    rawData: unknown,
  ) {
    const data = rawData as CreateWithMessageData
    const ws = ctx.ws

    // 1. Create the channel
    const channel = await channelManager.createChannel(
      ctx.userId,
      data.agentId,
      data.metadata,
      { workspaceId: data.workspaceId },
    )

    const channelData = {
      channelId: channel.channelId,
      agentId: channel.agentId,
      title: channel.metadata?.name || 'Nuevo chat',
      status: channel.status,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      workspaceId: channel.workspaceId,
    }

    // 2. Broadcast to all user sessions for conversation list updates
    const sessions = sessionManager.getUserSessions(ctx.userId)
    const broadcastMsg = JSON.stringify({
      type: 'channel_list_status',
      channelId: channel.channelId,
      action: 'created',
      channel: channelData,
    })
    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(broadcastMsg)
      }
    }

    // 3. Subscribe this session to the channel
    const sessionId = getSessionId(ws)
    if (sessionId) {
      sessionManager.subscribeToChannel(sessionId, channel.channelId)
    }

    // 4. Send the message (saves, broadcasts, triggers agent response)
    await messageHandler.handleSendMessage(ws, ctx.userId, {
      type: 'send_message',
      channelId: channel.channelId,
      content: data.content,
    })

    return {
      channelId: channel.channelId,
      agentId: channel.agentId,
      channel: channelData,
    }
  }
}
