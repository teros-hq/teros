/**
 * channel.list — List channels for the current user (paginated)
 */

import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'

interface ListChannelData {
  workspaceId?: string
  status?: string
  /** Max channels per page (default: 30, max: 100) */
  limit?: number
  /** Opaque cursor for next page, from a previous response's nextCursor */
  cursor?: string
}

export function createListChannelsHandler(channelManager: ChannelManager) {
  return async function listChannels(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as ListChannelData
    const { workspaceId, status, limit, cursor } = data

    // If workspaceId is undefined, pass null to get ALL channels (global + workspace)
    // If workspaceId is a string, filter by that specific workspace
    const effectiveWorkspaceId = workspaceId === undefined ? null : workspaceId

    console.log(
      `[channel.list] Listing channels for user: ${ctx.userId}${workspaceId ? ` (workspace: ${workspaceId})` : ' (all channels)'}${cursor ? ' (paginated)' : ''}`,
    )

    const result = await channelManager.listUserChannels(ctx.userId, status as any, {
      workspaceId: effectiveWorkspaceId,
      limit,
      cursor,
    })

    console.log(`[channel.list] Found ${result.channels.length} channels, hasMore: ${result.hasMore}`)

    return {
      channels: result.channels,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      workspaceId: workspaceId ?? undefined,
    }
  }
}
