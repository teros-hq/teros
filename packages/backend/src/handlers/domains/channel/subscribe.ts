/**
 * channel.subscribe — Subscribe the current session to a channel's real-time events
 *
 * Also restores any pending permission requests so the client can re-display them.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { AgentPhase } from '@teros/core'
import type { ChannelManager } from '../../../services/channel-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import type { MessageHandler } from '../../message-handler'

interface SubscribeChannelData {
  channelId: string
}

export function createSubscribeChannelHandler(
  channelManager: ChannelManager,
  pubSubService: PubSubService,
  messageHandler: MessageHandler,
) {
  return async function subscribeChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SubscribeChannelData

    console.log(
      `📺 [channel.subscribe] session=${ctx.sessionId}, user=${ctx.userId}, channel=${data.channelId}`,
    )

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      console.warn(
        `⚠️ [channel.subscribe] Denied: user ${ctx.userId} cannot access channel ${data.channelId}`,
      )
      throw new HandlerError('UNAUTHORIZED', 'Access denied to channel')
    }

    pubSubService.subscribeSession(ctx.sessionId, `channel:${data.channelId}`)
    console.log(
      `✅ [channel.subscribe] session=${ctx.sessionId} subscribed to channel=${data.channelId}`,
    )

    // Restore any pending permission requests for this channel
    await messageHandler.restorePendingPermissions(data.channelId)

    // Restore any pending inline forms (request-user-input) for this channel
    await messageHandler.restorePendingForms(data.channelId)

    // Snapshot so a fresh tab/reconnect can hydrate without waiting for the next push event.
    const snapshot = await messageHandler
      .getChannelRuntimeSnapshot(data.channelId)
      .catch(() => ({
        pendingUserMessageIds: [] as string[],
        runningUserMessageId: undefined as string | undefined,
        agentPhase: undefined as AgentPhase | undefined,
        running: false,
      }))

    return {
      channelId: data.channelId,
      pendingUserMessageIds: snapshot.pendingUserMessageIds,
      runningUserMessageId: snapshot.runningUserMessageId,
      agentPhase: snapshot.agentPhase,
      running: snapshot.running,
    }
  }
}
