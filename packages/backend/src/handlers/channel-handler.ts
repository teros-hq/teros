/**
 * Channel Handler
 * Handles channel-related operations
 */

import type {
  AutonameChannelMessage,
  CloseChannelMessage,
  CreateChannelMessage,
  GetChannelMessage,
  ListChannelsMessage,
  MarkChannelReadMessage,
  RenameChannelMessage,
  SearchConversationsMessage,
  SetChannelPrivateMessage,
  SubscribeChannelMessage,
  UnsubscribeChannelMessage,
  UserId,
} from '@teros/shared';
import type { WebSocket } from 'ws';
import type { ChannelManager } from '../services/channel-manager';
import type { SessionManager } from '../services/session-manager';

export class ChannelHandler {
  constructor(
    private channelManager: ChannelManager,
    private sessionManager: SessionManager,
  ) {}

  /**
   * Handle list_channels request
   */
  async handleListChannels(
    ws: WebSocket,
    userId: UserId,
    message: ListChannelsMessage,
  ): Promise<void> {
    const workspaceId = message.workspaceId;
    // If workspaceId is undefined, pass null to get ALL channels (global + workspace)
    // If workspaceId is a string, filter by that specific workspace
    const effectiveWorkspaceId = workspaceId === undefined ? null : workspaceId;
    console.log(
      `[ChannelHandler] Listing channels for user: ${userId}${workspaceId ? ` (workspace: ${workspaceId})` : ' (all channels)'}`,
    );
    const result = await this.channelManager.listUserChannels(userId, message.status, {
      workspaceId: effectiveWorkspaceId,
    });
    console.log(`[ChannelHandler] Found ${result.channels.length} channels`);

    this.sendResponse(ws, {
      type: 'channels_list',
      channels: result.channels,
      workspaceId: workspaceId ?? undefined,
      requestId: message.requestId,
    });
    console.log(`[ChannelHandler] Sent channels_list response`);
  }

  /**
   * Handle create_channel request
   */
  async handleCreateChannel(
    ws: WebSocket,
    userId: UserId,
    message: CreateChannelMessage,
  ): Promise<void> {
    const channel = await this.channelManager.createChannel(
      userId,
      message.agentId,
      message.metadata,
      { workspaceId: message.workspaceId },
    );

    const baseChannelData = {
      channelId: channel.channelId,
      agentId: channel.agentId,
      title: channel.metadata?.name || 'Nuevo chat',
      status: channel.status,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      workspaceId: channel.workspaceId,
    };

    // Enrich with agent info and model
    const channelData = await this.channelManager.enrichChannel(baseChannelData);

    // 1. Send direct response to the requesting client
    this.sendResponse(ws, {
      type: 'channel_created',
      channelId: channel.channelId,
      agentId: channel.agentId,
      channel: channelData,
    });

    // 2. Broadcast to all user sessions so conversation lists update in real-time
    this.broadcastToUser(userId, {
      type: 'channel_list_status',
      channelId: channel.channelId,
      action: 'created',
      channel: channelData,
    });
  }

  /**
   * Handle get_channel request
   */
  async handleGetChannel(ws: WebSocket, userId: UserId, message: GetChannelMessage): Promise<void> {
    const details = await this.channelManager.getChannelDetails(message.channelId);

    if (!details) {
      this.sendError(ws, 'CHANNEL_NOT_FOUND', 'Channel not found');
      return;
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId);
    if (!canAccess) {
      this.sendError(ws, 'UNAUTHORIZED', 'Access denied');
      return;
    }

    this.sendResponse(ws, {
      type: 'channel_details',
      ...details,
    });
  }

  /**
   * Handle close_channel request
   */
  async handleCloseChannel(
    ws: WebSocket,
    userId: UserId,
    message: CloseChannelMessage,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(message.channelId);

    if (!channel) {
      this.sendError(ws, 'CHANNEL_NOT_FOUND', 'Channel not found');
      return;
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId);
    if (!canAccess) {
      this.sendError(ws, 'UNAUTHORIZED', 'Access denied');
      return;
    }

    await this.channelManager.closeChannel(message.channelId);

    // Broadcast to all user sessions
    this.broadcastToUser(userId, {
      type: 'channel_list_status',
      channelId: message.channelId,
      action: 'deleted',
      channel: {
        channelId: message.channelId,
        status: 'closed',
      },
    });
  }

  /**
   * Handle reopen_channel request
   */
  async handleReopenChannel(
    ws: WebSocket,
    userId: UserId,
    message: { channelId: string },
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(message.channelId);

    if (!channel) {
      this.sendError(ws, 'CHANNEL_NOT_FOUND', 'Channel not found');
      return;
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId);
    if (!canAccess) {
      this.sendError(ws, 'UNAUTHORIZED', 'Access denied');
      return;
    }

    await this.channelManager.reopenChannel(message.channelId);

    // Broadcast to all user sessions
    this.broadcastToUser(userId, {
      type: 'channel_list_status',
      channelId: message.channelId,
      action: 'created', // Treat reopen as created for the list
      channel: {
        channelId: message.channelId,
        status: 'active',
      },
    });
  }

  /**
   * Handle subscribe_channel request
   */
  async handleSubscribeChannel(
    ws: WebSocket,
    sessionId: string,
    userId: UserId,
    message: SubscribeChannelMessage,
  ): Promise<void> {
    console.log(
      `📺 [ChannelHandler] Subscribe request: session=${sessionId}, user=${userId}, channel=${message.channelId}`,
    );

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId);
    if (!canAccess) {
      console.warn(
        `⚠️ [ChannelHandler] Subscribe denied: user ${userId} cannot access channel ${message.channelId}`,
      );
      this.sendError(ws, 'UNAUTHORIZED', 'Access denied to channel');
      return;
    }

    this.sessionManager.subscribeToChannel(sessionId, message.channelId);
    console.log(
      `✅ [ChannelHandler] Subscribed: session=${sessionId} to channel=${message.channelId}`,
    );

    // Send success response
    this.sendResponse(ws, {
      type: 'channel_subscribed',
      channelId: message.channelId,
    });
  }

  /**
   * Handle unsubscribe_channel request
   */
  async handleUnsubscribeFromChannel(
    ws: WebSocket,
    sessionId: string,
    message: UnsubscribeChannelMessage,
  ): Promise<void> {
    this.sessionManager.unsubscribeFromChannel(sessionId, message.channelId);

    this.sendResponse(ws, {
      type: 'channel_closed', // TODO: Add generic success type
      channelId: message.channelId,
    });
  }

  /**
   * Handle rename_channel request
   */
  async handleRenameChannel(
    ws: WebSocket,
    userId: UserId,
    message: RenameChannelMessage,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(message.channelId);

    if (!channel) {
      this.sendError(ws, 'CHANNEL_NOT_FOUND', 'Channel not found');
      return;
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId);
    if (!canAccess) {
      this.sendError(ws, 'UNAUTHORIZED', 'Access denied');
      return;
    }

    await this.channelManager.renameChannel(message.channelId, message.name);

    // Broadcast channel_list_status to all user sessions (for conversation list)
    this.broadcastToUser(userId, {
      type: 'channel_list_status',
      channelId: message.channelId,
      action: 'updated',
      channel: {
        channelId: message.channelId,
        title: message.name,
      },
    });

    // Broadcast channel_status to channel subscribers (for tabs)
    this.broadcastToChannel(message.channelId, {
      type: 'channel_status',
      channelId: message.channelId,
      title: message.name,
    });
  }

  /**
   * Handle autoname_channel request
   * Uses Haiku to generate a name based on conversation content
   */
  async handleAutonameChannel(
    ws: WebSocket,
    userId: UserId,
    message: AutonameChannelMessage,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(message.channelId);

    if (!channel) {
      this.sendError(ws, 'CHANNEL_NOT_FOUND', 'Channel not found');
      return;
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId);
    if (!canAccess) {
      this.sendError(ws, 'UNAUTHORIZED', 'Access denied');
      return;
    }

    const name = await this.channelManager.autonameChannel(message.channelId);

    if (!name) {
      this.sendError(ws, 'AUTONAME_FAILED', 'Could not generate name for channel');
      return;
    }

    // Broadcast channel_list_status to all user sessions (for conversation list)
    this.broadcastToUser(userId, {
      type: 'channel_list_status',
      channelId: message.channelId,
      action: 'updated',
      channel: {
        channelId: message.channelId,
        title: name,
      },
    });

    // Broadcast channel_status to channel subscribers (for tabs)
    this.broadcastToChannel(message.channelId, {
      type: 'channel_status',
      channelId: message.channelId,
      title: name,
    });
  }

  /**
   * Handle set_channel_private request
   * Marks a channel as private (hidden from lists/search, deleted on close)
   */
  async handleSetChannelPrivate(
    ws: WebSocket,
    userId: UserId,
    message: SetChannelPrivateMessage,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(message.channelId);

    if (!channel) {
      this.sendError(ws, 'CHANNEL_NOT_FOUND', 'Channel not found');
      return;
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId);
    if (!canAccess) {
      this.sendError(ws, 'UNAUTHORIZED', 'Access denied');
      return;
    }

    await this.channelManager.setChannelPrivate(message.channelId, message.isPrivate);

    // Send confirmation to the requesting client
    this.sendResponse(ws, {
      type: 'channel_private_updated',
      channelId: message.channelId,
      isPrivate: message.isPrivate,
    });

    // Broadcast channel_status to channel subscribers
    this.broadcastToChannel(message.channelId, {
      type: 'channel_status',
      channelId: message.channelId,
      isPrivate: message.isPrivate,
    });

    // If set to private, remove from conversation lists of all user sessions
    if (message.isPrivate) {
      this.broadcastToUser(userId, {
        type: 'channel_list_status',
        channelId: message.channelId,
        action: 'deleted', // Remove from list view
        channel: {
          channelId: message.channelId,
          status: 'active',
          isPrivate: true,
        },
      });
    }
  }

  private sendResponse(ws: WebSocket, message: any): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast message to all sessions of a user
   */
  private broadcastToUser(userId: UserId, message: any): void {
    const sessions = this.sessionManager.getUserSessions(userId);
    const messageStr = JSON.stringify(message);

    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(messageStr);
      }
    }
  }

  /**
   * Broadcast message to all subscribers of a channel
   */
  private broadcastToChannel(channelId: string, message: any): void {
    const subscribers = this.sessionManager.getChannelSubscribers(channelId);
    const messageStr = JSON.stringify(message);

    for (const session of subscribers) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(messageStr);
      }
    }
  }

  /**
   * Handle mark_channel_read request
   */
  async handleMarkChannelRead(
    ws: WebSocket,
    userId: UserId,
    message: MarkChannelReadMessage,
  ): Promise<void> {
    try {
      await this.channelManager.markChannelAsRead(message.channelId, userId);

      this.sendResponse(ws, {
        type: 'channel_read',
        channelId: message.channelId,
      });
    } catch (error: any) {
      this.sendError(ws, 'MARK_READ_FAILED', error.message);
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code,
          message,
        }),
      );
    }
  }

  /**
   * Handle search_conversations request
   * Searches message content across all user's channels
   */
  async handleSearchConversations(
    ws: WebSocket,
    userId: UserId,
    message: SearchConversationsMessage,
  ): Promise<void> {
    try {
      const { query, limit } = message;
      console.log(`[ChannelHandler] Searching conversations for user ${userId}: "${query}"`);

      const { results, totalMatches } = await this.channelManager.searchMessages(
        userId,
        query,
        limit || 50,
      );

      this.sendResponse(ws, {
        type: 'search_results',
        query,
        results,
        totalMatches,
      });

      console.log(
        `[ChannelHandler] Search returned ${totalMatches} matches in ${results.length} channels`,
      );
    } catch (error: any) {
      console.error('[ChannelHandler] Search error:', error);
      this.sendError(ws, 'SEARCH_ERROR', error.message || 'Search failed');
    }
  }
}
