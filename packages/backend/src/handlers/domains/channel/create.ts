/**
 * channel.create — Create a new channel for the user
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { assertCanCreateChannel } from '../../../services/channel-authz'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { WorkspaceService } from '../../../services/workspace-service'

interface CreateChannelData {
  agentId: string
  metadata?: Record<string, any>
  workspaceId?: string
  parentChannelId?: string
}

export function createCreateChannelHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
  workspaceService: WorkspaceService | null,
  db: Db,
) {
  return async function createChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateChannelData

    if (!data.agentId) {
      throw new Error('[channel.create] agentId is required')
    }

    // Resolve workspaceId: explicit > inherited from parent channel
    let workspaceId = data.workspaceId

    if (!workspaceId && data.parentChannelId) {
      const parentChannel = await channelManager.getChannel(data.parentChannelId)
      if (!parentChannel) {
        throw new Error(
          `[channel.create] parentChannelId "${data.parentChannelId}" not found. Cannot inherit workspaceId.`,
        )
      }
      if (!parentChannel.workspaceId) {
        throw new Error(
          `[channel.create] parentChannel "${data.parentChannelId}" has no workspaceId. Cannot inherit workspaceId.`,
        )
      }
      workspaceId = parentChannel.workspaceId
    }

    if (!workspaceId) {
      throw new Error(
        `[channel.create] workspaceId is required. Provide it explicitly or via parentChannelId. agentId: ${data.agentId}`,
      )
    }

    // SEC-2 (TER-721 / A2): the caller must be a member of the target workspace
    // and allowed to use this agent in it. Without this any authenticated user
    // could create a channel in another tenant's workspace and drive its agent.
    await assertCanCreateChannel(db, workspaceService, ctx.userId, workspaceId, data.agentId)

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

    // Enrich with agent info and model
    const channelData = await channelManager.enrichChannel(baseChannelData)

    // Broadcast to all user sessions so conversation lists update in real-time
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

    return {
      channelId: channel.channelId,
      agentId: channel.agentId,
      channel: channelData,
    }
  }
}
