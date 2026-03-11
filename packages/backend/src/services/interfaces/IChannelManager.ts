/**
 * IChannelManager Interface
 *
 * Interface for channel (conversation) management operations.
 */

import type {
  AgentConfig,
  AgentId,
  Channel,
  ChannelId,
  ChannelMetadata,
  Message,
  UserApp,
  UserId,
} from '@teros/shared';

/**
 * Result of getMessages query
 */
export interface GetMessagesResult {
  messages: Message[];
  hasMore: boolean;
}

/**
 * Result of listUserChannels query (paginated)
 */
export interface ListChannelsResult {
  channels: Channel[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Channel details with related data
 */
export interface ChannelDetails {
  channel: Channel;
  agentConfig: AgentConfig;
  userApps: UserApp[];
  recentMessages: Message[];
}

/**
 * Interface for Channel Manager
 */
export interface IChannelManager {
  // ============================================================================
  // CHANNEL OPERATIONS
  // ============================================================================

  /**
   * Create a new channel
   */
  createChannel(
    userId: UserId,
    agentId: AgentId,
    metadata?: Partial<ChannelMetadata>,
    options?: { workspaceId?: string },
  ): Promise<Channel>;

  /**
   * Get channel by ID
   */
  getChannel(channelId: ChannelId): Promise<Channel | null>;

  /**
   * List user's channels (paginated)
   * @param options.workspaceId - Filter by workspace (undefined = global only, null = all)
   * @param options.limit - Max channels to return (default: 30)
   * @param options.cursor - Opaque cursor for next page (from previous response)
   */
  listUserChannels(
    userId: UserId,
    status?: 'active' | 'closed',
    options?: { workspaceId?: string | null; limit?: number; cursor?: string },
  ): Promise<ListChannelsResult>;

  /**
   * Mark channel as read
   */
  markChannelAsRead(channelId: ChannelId, userId: UserId): Promise<void>;

  /**
   * Close a channel
   */
  closeChannel(channelId: ChannelId): Promise<void>;

  /**
   * Reopen a closed channel
   */
  reopenChannel(channelId: ChannelId): Promise<void>;

  /**
   * Rename a channel
   */
  renameChannel(channelId: ChannelId, name: string): Promise<void>;

  /**
   * Auto-generate channel name from conversation
   */
  autonameChannel(channelId: ChannelId): Promise<string | null>;

  /**
   * Get channel with full details
   */
  getChannelDetails(channelId: ChannelId): Promise<ChannelDetails | null>;

  // ============================================================================
  // MESSAGE OPERATIONS
  // ============================================================================

  /**
   * Save a message
   */
  saveMessage(message: Message): Promise<void>;

  /**
   * Get message by ID
   */
  getMessage(messageId: string): Promise<Message | null>;

  /**
   * Update message content
   */
  updateMessageContent(messageId: string, content: any): Promise<void>;

  /**
   * Get messages for a channel with pagination
   */
  getMessages(channelId: ChannelId, limit?: number, before?: string): Promise<GetMessagesResult>;

  // ============================================================================
  // ID GENERATION
  // ============================================================================

  /**
   * Create a new channel ID
   */
  createChannelId(): ChannelId;

  /**
   * Create a new message ID
   */
  createMessageId(): string;
}
