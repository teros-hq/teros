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
import type { Db } from 'mongodb'
import { assertCanCreateChannel } from '../../../services/channel-authz'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { MessageHandler } from '../../message-handler'

interface CreateWithMessageData {
  agentId: string
  content: any
  metadata?: Record<string, any>
  workspaceId?: string
  parentChannelId?: string
  /** When false, save the first message without waking the agent (used to batch
   *  multiple first-message attachments before a single turn). Defaults to true. */
  wakeUpAgent?: boolean
}

export interface CreateWithMessageDeps {
  channelManager: ChannelManager
  sessionManager: SessionManager
  pubSubService: PubSubService
  messageHandler: MessageHandler
  workspaceService: WorkspaceService | null
  db: Db
  /** Returns the sessionId for the given WebSocket connection */
  getSessionId: (ws: WebSocket) => string | undefined
}

/**
 * Returns a handler factory that requires ws to be passed at call time.
 * Used by the domain index to register a WsHandler-compatible wrapper.
 */
export function createCreateWithMessageHandler(deps: CreateWithMessageDeps) {
  const { channelManager, sessionManager, pubSubService, messageHandler, workspaceService, db, getSessionId } =
    deps

  return async function createChannelWithMessage(
    ctx: WsHandlerContext & { ws: WebSocket },
    rawData: unknown,
  ) {
    const data = rawData as CreateWithMessageData
    const ws = ctx.ws

    if (!data.agentId) {
      throw new Error('[channel.create-with-message] agentId is required')
    }

    // Resolve workspaceId: explicit > inherited from parent channel
    let workspaceId = data.workspaceId

    if (!workspaceId && data.parentChannelId) {
      const parentChannel = await channelManager.getChannel(data.parentChannelId)
      if (!parentChannel) {
        throw new Error(
          `[channel.create-with-message] parentChannelId "${data.parentChannelId}" not found. Cannot inherit workspaceId.`,
        )
      }
      if (!parentChannel.workspaceId) {
        throw new Error(
          `[channel.create-with-message] parentChannel "${data.parentChannelId}" has no workspaceId. Cannot inherit workspaceId.`,
        )
      }
      workspaceId = parentChannel.workspaceId
    }

    if (!workspaceId) {
      throw new Error(
        `[channel.create-with-message] workspaceId is required. Provide it explicitly or via parentChannelId. agentId: ${data.agentId}`,
      )
    }

    // SEC-2 (TER-721 / A2): same authz gate as channel.create — this is the
    // parallel channel-creation path and must enforce the same invariant, or the
    // hole moves here (the "re-audit every use, not just the obvious one" rule).
    await assertCanCreateChannel(db, workspaceService, ctx.userId, workspaceId, data.agentId)

    // 1. Create the channel
    const channel = await channelManager.createChannel(
      ctx.userId,
      data.agentId,
      data.metadata,
      {
        workspaceId,
        ...(data.parentChannelId && { originChannelId: data.parentChannelId }),
      },
    )

    const baseChannelData = {
      channelId: channel.channelId,
      agentId: channel.agentId,
      title: channel.metadata?.name || 'Nuevo chat',
      status: channel.status,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      workspaceId: channel.workspaceId,
    }

    // Enrich with agent info (agentName, agentAvatarUrl, model) so consumers
    // of the broadcast (NavBar, conversation list) can render the chat with
    // the agent's identity immediately. Mirrors what channel.create does.
    const channelData = await channelManager.enrichChannel(baseChannelData)

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
      pubSubService.subscribeSession(sessionId, `channel:${channel.channelId}`)
    }

    // 4. Send the message (saves, broadcasts, triggers agent response)
    await messageHandler.handleSendMessage(ws, ctx.userId, {
      type: 'send_message',
      channelId: channel.channelId,
      content: data.content,
      ...(data.wakeUpAgent !== undefined ? { wakeUpAgent: data.wakeUpAgent } : {}),
    })

    return {
      channelId: channel.channelId,
      agentId: channel.agentId,
      channel: channelData,
    }
  }
}
