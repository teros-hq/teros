/**
 * Channel Manager
 * Manages channels (conversations) in MongoDB
 */

import { generateChannelId, generateMessageId } from '@teros/core';
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
import type { Collection, Db } from 'mongodb';
import { config } from '../config';

/**
 * Build full avatar URL from filename
 * DB stores only filename (e.g., "alice-avatar.jpg")
 */
function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined;
  // If already a full URL, return as-is
  if (avatarFilename.startsWith('http://') || avatarFilename.startsWith('https://')) {
    return avatarFilename;
  }
  return `${config.static.baseUrl}/${avatarFilename}`;
}

interface Agent {
  agentId: string;
  name: string;
  fullName: string;
  avatarUrl?: string;
  selectedModelId?: string;
  selectedProviderId?: string;
}

interface Workspace {
  workspaceId: string;
  ownerId: string;
  members: Array<{ userId: string; role: string }>;
  status: string;
}

import { InternalLLMService } from './internal-llm-service';
import type { ProviderService } from './provider-service';
import type { ListChannelsResult } from './interfaces/IChannelManager';

// ─── Pagination helpers ───────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 30;

interface ChannelCursor {
  updatedAt: string;
  channelId: string;
}

function encodeCursor(cursor: ChannelCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string): ChannelCursor | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as ChannelCursor;
  } catch {
    return null;
  }
}

export class ChannelManager {
  private channels: Collection<Channel>;
  private agentConfigs: Collection<AgentConfig>;
  private userApps: Collection<UserApp>;
  private messages: Collection<Message>;
  private agents: Collection<Agent>;
  private agentCores: Collection<any>;
  private models: Collection<any>;
  private workspaces: Collection<Workspace>;
  private users: Collection<any>;
  private internalLLM: InternalLLMService;

  constructor(
    private db: Db,
    private providerService: ProviderService,
  ) {
    this.channels = db.collection<Channel>('channels');
    this.agentConfigs = db.collection<AgentConfig>('agent_configs');
    this.userApps = db.collection<UserApp>('user_apps');
    this.messages = db.collection<Message>('channel_messages');
    this.agents = db.collection<Agent>('agents');
    this.agentCores = db.collection('agent_cores');
    this.models = db.collection('models');
    this.workspaces = db.collection<Workspace>('workspaces');
    this.users = db.collection('users');
    this.internalLLM = new InternalLLMService(db, providerService);
  }

  /**
   * Ensure required indexes exist for optimal query performance
   */
  async ensureIndexes(): Promise<void> {
    // Messages: query by channelId, sorted by createdAt (most common query)
    await this.messages.createIndex(
      { channelId: 1, createdAt: -1 },
      { name: 'channelId_1_createdAt_-1', background: true },
    );

    // Channels: query by userId, sorted by updatedAt
    await this.channels.createIndex(
      { userId: 1, updatedAt: -1 },
      { name: 'userId_1_updatedAt_-1', background: true },
    );

    // Channels: query by channelId (for lookups)
    await this.channels.createIndex(
      { channelId: 1 },
      { name: 'channelId_1', unique: true, background: true },
    );

    console.log('✅ ChannelManager indexes ensured');
  }

  /**
   * Create a new channel
   */
  async createChannel(
    userId: UserId,
    agentId: AgentId,
    metadata: Partial<ChannelMetadata> = {},
    options?: { workspaceId?: string; headless?: boolean; originChannelId?: string },
  ): Promise<Channel> {
    const channelId = this.createChannelId();
    const now = new Date().toISOString();

    // Get agent name for default channel name
    const agent = await this.agents.findOne({ agentId } as any);
    const agentName = agent?.name || agentId;
    const defaultName = `Chat con ${agentName}`;

    // Determine workspaceId: explicit option > agent's workspace > none
    const workspaceId = options?.workspaceId || (agent as any)?.workspaceId || undefined;

    const channel: Channel = {
      channelId,
      userId,
      agentId,
      status: 'active',
      metadata: {
        transport: metadata.transport || 'websocket',
        name: metadata.name || defaultName,
        ...metadata,
      },
      createdAt: now,
      updatedAt: now,
      ...(workspaceId && { workspaceId }),
      ...(options?.headless && { headless: true }),
      ...(options?.originChannelId && { originChannelId: options.originChannelId }),
    };

    await this.channels.insertOne(channel as any);
    console.log(
      `✅ Channel created: ${channelId} - "${channel.metadata.name}"${workspaceId ? ` (workspace: ${workspaceId})` : ''}`,
    );

    // Create default agent config for this channel
    await this.createDefaultAgentConfig(channelId, agentId);

    return channel;
  }

  /**
   * Get channel by ID
   */
  async getChannel(channelId: ChannelId): Promise<Channel | null> {
    const channel = await this.channels.findOne({ channelId } as any);
    return channel as Channel | null;
  }

  /**
   * Check if a user can access a channel
   * Access is granted if:
   * - User is the channel owner (userId matches)
   * - Channel belongs to a workspace where user is owner or member
   */
  async canAccessChannel(channelId: ChannelId, userId: UserId): Promise<boolean> {
    const channel = await this.getChannel(channelId);
    if (!channel) return false;

    // User is the channel owner
    if (channel.userId === userId) return true;

    // Channel belongs to a workspace - check workspace access
    if (channel.workspaceId) {
      const workspace = await this.workspaces.findOne({
        workspaceId: channel.workspaceId,
        status: 'active',
        $or: [{ ownerId: userId }, { 'members.userId': userId }],
      });
      return workspace !== null;
    }

    return false;
  }

  /**
   * List user's channels with unread counts (paginated)
   * Note: Private channels are included but marked with isPrivate: true
   * The frontend should filter them from the conversation list UI
   *
   * @param userId - User ID
   * @param status - Filter by status (active/closed)
   * @param options.workspaceId - Filter by workspace ID:
   *   - undefined: global channels only (no workspace)
   *   - null: all channels (global + all accessible workspaces)
   *   - string: specific workspace only
   * @param options.limit - Max channels per page (default: 30)
   * @param options.cursor - Opaque pagination cursor from previous response
   */
  async listUserChannels(
    userId: UserId,
    status?: 'active' | 'closed',
    options?: { workspaceId?: string | null; limit?: number; cursor?: string },
  ): Promise<ListChannelsResult> {
    const limit = Math.min(options?.limit ?? DEFAULT_PAGE_SIZE, 100);

    let baseFilter: any;

    if (options?.workspaceId === null) {
      // Return ALL channels: global + all accessible workspaces
      const accessibleWorkspaces = await this.workspaces
        .find({
          status: 'active',
          $or: [{ ownerId: userId }, { 'members.userId': userId }],
        })
        .toArray();

      const workspaceIds = accessibleWorkspaces.map((w) => w.workspaceId);

      baseFilter = {
        $or: [
          { userId, workspaceId: { $exists: false } }, // User's global channels
          { workspaceId: { $in: workspaceIds } },       // Channels in accessible workspaces
        ],
      };
    } else if (options?.workspaceId) {
      // Specific workspace only
      baseFilter = { workspaceId: options.workspaceId };
    } else {
      // Global channels only (no workspace) - default behavior
      baseFilter = { userId, workspaceId: { $exists: false } };
    }

    // Add status filter if provided
    if (status) {
      baseFilter.status = status;
    }

    // Apply cursor for keyset pagination (updatedAt DESC, channelId ASC as tiebreaker)
    let filter = baseFilter;
    if (options?.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        filter = {
          ...baseFilter,
          $or: [
            { updatedAt: { $lt: decoded.updatedAt } },
            { updatedAt: decoded.updatedAt, channelId: { $gt: decoded.channelId } },
          ],
        };
        // Merge with existing $or if present (workspaceId=null case)
        if (baseFilter.$or) {
          filter = {
            $and: [
              { $or: baseFilter.$or },
              {
                $or: [
                  { updatedAt: { $lt: decoded.updatedAt } },
                  { updatedAt: decoded.updatedAt, channelId: { $gt: decoded.channelId } },
                ],
              },
              ...(status ? [{ status }] : []),
            ],
          };
        }
      }
    }

    // Fetch one extra to detect if there's a next page
    const rawChannels = await this.channels
      .find(filter)
      .sort({ updatedAt: -1, channelId: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = rawChannels.length > limit;
    const pageChannels = rawChannels.slice(0, limit);

    // Build next cursor from the last item of the current page
    let nextCursor: string | null = null;
    if (hasMore && pageChannels.length > 0) {
      const last = pageChannels[pageChannels.length - 1];
      nextCursor = encodeCursor({ updatedAt: last.updatedAt, channelId: last.channelId });
    }

    // Enrich channels with unread counts, last message, agent info, and model
    const enrichedChannels = await Promise.all(
      pageChannels.map(async (channel) => {
        const [unreadCount, lastMessage, agentInfo] = await Promise.all([
          this.getUnreadCount(channel.channelId, (channel as any).lastReadAt),
          this.getLastMessage(channel.channelId),
          this.getAgentInfo(channel.agentId),
        ]);

        return {
          ...channel,
          unreadCount,
          lastMessage,
          agentName: agentInfo?.agentName,
          agentAvatarUrl: agentInfo?.avatarUrl,
          modelString: agentInfo?.modelString,
          modelName: agentInfo?.modelName,
          providerName: agentInfo?.providerName,
        };
      }),
    );

    console.log(
      `[channel.list] Page: ${enrichedChannels.length} channels, hasMore: ${hasMore}`,
    );

    return {
      channels: enrichedChannels as Channel[],
      nextCursor,
      hasMore,
    };
  }

  /**
   * Get count of unread messages for a channel
   */
  private async getUnreadCount(channelId: ChannelId, lastReadAt?: string): Promise<number> {
    const filter: any = {
      channelId,
      role: 'assistant',
    };

    if (lastReadAt) {
      filter.timestamp = { $gt: lastReadAt };
    }

    return this.messages.countDocuments(filter);
  }

  /**
   * Get last message preview for a channel
   * Prioritizes text messages for better previews
   */
  private async getLastMessage(
    channelId: ChannelId,
  ): Promise<{ content: string; timestamp: string; role?: 'user' | 'assistant' } | undefined> {
    // First try to find the last text message for a meaningful preview
    const textMessage = await this.messages.findOne(
      {
        channelId,
        'content.type': 'text',
      } as any,
      { sort: { timestamp: -1 } },
    );

    if (textMessage) {
      const content = (textMessage.content as any).text || '';
      const truncated = content.length > 100 ? content.substring(0, 100) + '...' : content;

      return {
        content: truncated,
        timestamp: textMessage.timestamp,
        role: textMessage.role as 'user' | 'assistant',
      };
    }

    // Fallback to the most recent message of any type
    const message = await this.messages.findOne({ channelId } as any, { sort: { timestamp: -1 } });

    if (!message) return undefined;

    // For non-text messages, show a friendly description
    let content = '';
    const contentType = message.content?.type;

    if (contentType === 'image') {
      content = '📷 Imagen';
    } else if (contentType === 'audio') {
      content = '🎵 Audio';
    } else if (contentType === 'video') {
      content = '🎬 Video';
    } else if (contentType === 'file') {
      content = '📎 Archivo';
    } else {
      // For tool_execution and other types, just show empty to avoid clutter
      content = '';
    }

    return {
      content,
      timestamp: message.timestamp,
      role: message.role as 'user' | 'assistant',
    };
  }

  /**
   * Get agent info including name, avatar, and model string
   */
  private async getAgentInfo(
    agentId: string,
  ): Promise<{ agentName: string; avatarUrl?: string; modelString?: string; modelName?: string; providerName?: string } | null> {
    const agent = await this.agents.findOne({ agentId } as any);
    if (!agent) {
      console.log(`[getAgentInfo] Agent not found: ${agentId}`);
      return null;
    }

    // Get model from agent's selectedModelId (not from agent_core, which is legacy)
    let modelString: string | undefined;
    let modelName: string | undefined;
    let providerName: string | undefined;
    
    if (agent.selectedModelId) {
      // First try to find in global models collection
      const model = await this.models.findOne({ modelId: agent.selectedModelId } as any);
      if (model) {
        modelString = model.modelString;
        // Strip provider suffix from model name (e.g., "Claude Sonnet 4.5 (OpenRouter)" → "Claude Sonnet 4.5")
        modelName = (model.name || '').replace(/\s*\([^)]+\)\s*$/, '').trim() || model.name;
      } else {
        // If not found in global models, it might be a provider-specific model
        // In this case, we'll use the modelId as modelString
        modelString = agent.selectedModelId;
      }
    }

    // Get provider display name
    if (agent.selectedProviderId) {
      const userProvider = await this.db.collection('user_providers').findOne({ 
        providerId: agent.selectedProviderId 
      } as any);
      if (userProvider) {
        providerName = userProvider.displayName; // e.g., "OpenRouter", "Claude Max"
      }
    }
    
    const result = {
      agentName: agent.name || agent.fullName || agentId,
      avatarUrl: buildAvatarUrl(agent.avatarUrl),
      modelString,
      modelName,
      providerName,
    };
    
    return result;
  }

  /**
   * Enrich a channel with agent info and model string
   */
  async enrichChannel(channel: any): Promise<any> {
    const agentInfo = await this.getAgentInfo(channel.agentId);
    return {
      ...channel,
      agentName: agentInfo?.agentName,
      agentAvatarUrl: agentInfo?.avatarUrl,
      modelString: agentInfo?.modelString,
      modelName: agentInfo?.modelName,
      providerName: agentInfo?.providerName,
    };
  }

  /**
   * Mark channel as read (update lastReadAt)
   */
  async markChannelAsRead(channelId: ChannelId, userId: UserId): Promise<void> {
    const now = new Date().toISOString();

    // Verify access (owner or workspace member)
    const canAccess = await this.canAccessChannel(channelId, userId);
    if (!canAccess) {
      throw new Error('Channel not found or access denied');
    }

    await this.channels.updateOne({ channelId } as any, { $set: { lastReadAt: now } });

    console.log(`✓ Channel marked as read: ${channelId}`);
  }

  /**
   * Close a channel
   * If the channel is private, it will be completely deleted instead
   */
  async closeChannel(channelId: ChannelId): Promise<{ deleted: boolean }> {
    const channel = await this.getChannel(channelId);

    // If private channel, delete completely
    if (channel?.isPrivate) {
      await this.deleteChannelCompletely(channelId);
      return { deleted: true };
    }

    // Normal close for non-private channels
    const now = new Date().toISOString();
    await this.channels.updateOne({ channelId } as any, {
      $set: {
        status: 'closed',
        closedAt: now,
        updatedAt: now,
      },
    });
    console.log(`🔒 Channel closed: ${channelId}`);
    return { deleted: false };
  }

  /**
   * Completely delete a channel and all its data
   * Used for private channels on close or expiry
   */
  async deleteChannelCompletely(channelId: ChannelId): Promise<void> {
    // 1. Delete all messages
    const messagesResult = await this.messages.deleteMany({ channelId } as any);

    // 2. Delete agent config
    await this.agentConfigs.deleteMany({ channelId } as any);

    // 3. Delete channel
    await this.channels.deleteOne({ channelId } as any);

    console.log(
      `🗑️ Private channel completely deleted: ${channelId} (${messagesResult.deletedCount} messages)`,
    );
  }

  /**
   * Set a channel as private or public
   * Private channels are hidden from lists/search and deleted on close
   */
  async setChannelPrivate(channelId: ChannelId, isPrivate: boolean): Promise<void> {
    const now = new Date().toISOString();
    await this.channels.updateOne({ channelId } as any, {
      $set: {
        isPrivate,
        updatedAt: now,
      },
    });
    console.log(`🔒 Channel ${channelId} set to ${isPrivate ? 'private' : 'public'}`);
  }

  /**
   * Cleanup expired private channels (older than 15 days of inactivity)
   * Should be called periodically (e.g., every hour)
   */
  async cleanupExpiredPrivateChannels(): Promise<number> {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

    const expiredChannels = await this.channels
      .find({
        isPrivate: true,
        updatedAt: { $lt: fifteenDaysAgo },
      } as any)
      .toArray();

    let deletedCount = 0;
    for (const channel of expiredChannels) {
      await this.deleteChannelCompletely(channel.channelId);
      deletedCount++;
    }

    if (deletedCount > 0) {
      console.log(`🧹 Cleaned up ${deletedCount} expired private channels`);
    }

    return deletedCount;
  }

  /**
   * Reopen a closed channel
   */
  async reopenChannel(channelId: ChannelId): Promise<void> {
    const now = new Date().toISOString();
    await this.channels.updateOne({ channelId } as any, {
      $set: {
        status: 'active',
        updatedAt: now,
      },
      $unset: {
        closedAt: '',
      },
    });
    console.log(`🔓 Channel reopened: ${channelId}`);
  }

  /**
   * Rename a channel
   */
  async renameChannel(channelId: ChannelId, name: string): Promise<void> {
    const now = new Date().toISOString();
    await this.channels.updateOne({ channelId } as any, {
      $set: {
        'metadata.name': name,
        updatedAt: now,
      },
    });
    console.log(`✏️ Channel renamed: ${channelId} -> "${name}"`);
  }

  /**
   * Auto-generate a name for a channel using AI
   * If no messages, returns default name "Chat con {AgentName}"
   * Uses InternalLLMService which is configurable (model can be changed in DB)
   */
  async autonameChannel(channelId: ChannelId): Promise<string | null> {
    // Get channel to know the agent
    const channel = await this.getChannel(channelId);
    if (!channel) {
      return null;
    }

    // Get recent messages to understand context
    const { messages } = await this.getMessages(channelId, 10);

    // If no messages, return default name based on agent
    if (messages.length === 0) {
      const agent = await this.agents.findOne({ agentId: channel.agentId } as any);
      const agentName = agent?.name || channel.agentId;
      const defaultName = `Chat con ${agentName}`;
      await this.renameChannel(channelId, defaultName);
      console.log(`🔄 Channel reset to default name: ${channelId} -> "${defaultName}"`);
      return defaultName;
    }

    // Build context from messages
    const messageContext = messages
      .filter((m) => m.content.type === 'text')
      .map((m) => ({
        role: m.role,
        text: (m.content as { text: string }).text,
      }));

    try {
      // Use InternalLLMService (configurable model)
      const generatedName = await this.internalLLM.generateChannelName(messageContext);

      if (!generatedName) {
        return null;
      }

      // Save the name
      await this.renameChannel(channelId, generatedName);
      console.log(`🤖 Channel auto-named: ${channelId} -> "${generatedName}"`);

      return generatedName;
    } catch (error) {
      console.error('[ChannelManager] Error auto-naming channel:', error);
      return null;
    }
  }

  /**
   * Get channel details (channel + config + apps + recent messages)
   */
  async getChannelDetails(channelId: ChannelId): Promise<{
    channel: Channel;
    agentConfig: AgentConfig;
    userApps: UserApp[];
    recentMessages: Message[];
  } | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    const [agentConfig, userApps, recentMessages] = await Promise.all([
      this.getAgentConfig(channelId),
      this.getUserApps(channelId),
      this.getRecentMessages(channelId, 50),
    ]);

    if (!agentConfig) {
      throw new Error(`Agent config not found for channel ${channelId}`);
    }

    return {
      channel,
      agentConfig,
      userApps,
      recentMessages,
    };
  }

  /**
   * Save message to database
   */
  async saveMessage(message: Message): Promise<void> {
    await this.messages.insertOne(message as any);

    // Update channel's updatedAt
    await this.channels.updateOne({ channelId: message.channelId } as any, {
      $set: { updatedAt: message.timestamp },
    });
  }

  /**
   * Get a single message by ID
   */
  async getMessage(messageId: string): Promise<Message | null> {
    const message = await this.messages.findOne({ messageId } as any);
    return message as Message | null;
  }

  /**
   * Update message content (e.g., after transcription)
   */
  async updateMessageContent(messageId: string, content: any): Promise<void> {
    await this.messages.updateOne({ messageId } as any, { $set: { content } });
  }

  /**
   * Get messages for a channel
   */
  async getMessages(
    channelId: ChannelId,
    limit: number = 50,
    before?: string,
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    const filter: any = { channelId };

    if (before) {
      // Get message to use as cursor
      const beforeMessage = await this.messages.findOne({ messageId: before } as any);
      if (beforeMessage) {
        filter.timestamp = { $lt: beforeMessage.timestamp };
      }
    }

    const messages = await this.messages
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = messages.length > limit;
    const results = messages.slice(0, limit);

    return {
      messages: results as Message[],
      hasMore,
    };
  }

  /**
   * Get recent messages (for channel details)
   */
  private async getRecentMessages(channelId: ChannelId, limit: number): Promise<Message[]> {
    const messages = await this.messages
      .find({ channelId } as any)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    return messages.reverse() as Message[]; // Return in chronological order
  }

  /**
   * Create default agent config for a channel
   */
  private async createDefaultAgentConfig(channelId: ChannelId, agentId: AgentId): Promise<void> {
    // TODO: Load default config from agent definition
    const config: AgentConfig = {
      agentId,
      coreVersion: 'base-v0.7',
      config: {
        systemPrompt: `You are ${agentId}, a helpful AI assistant.`,
        personality: ['Professional', 'Helpful'],
        preferences: {
          responseStyle: 'concise',
          temperature: 0.7,
          maxTokens: 4000,
        },
      },
    };

    // Note: agentConfigs doesn't have channelId in the schema, but we need it for querying
    // We'll extend the type or use a different approach
    await this.agentConfigs.insertOne({ ...config, channelId } as any);
  }

  /**
   * Get agent config for a channel
   */
  private async getAgentConfig(channelId: ChannelId): Promise<AgentConfig | null> {
    const config = await this.agentConfigs.findOne({ channelId } as any);
    return config as AgentConfig | null;
  }

  /**
   * Get user apps available for a channel
   */
  private async getUserApps(channelId: ChannelId): Promise<UserApp[]> {
    const channel = await this.getChannel(channelId);
    if (!channel) return [];

    // Get apps available for this channel:
    // 1. Channel-specific apps
    // 2. Agent-specific apps
    // 3. Global apps
    const apps = await this.userApps
      .find({
        $or: [
          { channelId }, // Channel-specific
          { agentId: channel.agentId, channelId: { $exists: false } }, // Agent-specific
          { agentId: { $exists: false }, channelId: { $exists: false } }, // Global
        ],
        userId: channel.userId,
      } as any)
      .toArray();

    return apps as UserApp[];
  }

  /**
   * Generate unique channel ID
   */
  private createChannelId(): ChannelId {
    return generateChannelId();
  }

  /**
   * Generate unique message ID
   */
  createMessageId(): string {
    return generateMessageId();
  }

  /**
   * Get sender info for a user (human)
   */
  async getUserSender(
    userId: string,
  ): Promise<{ type: 'user'; id: string; name: string; avatarUrl?: string } | null> {
    const user = await this.users.findOne({ userId });
    if (!user) return null;
    // Use first name only (first word of display name)
    const fullName = user.profile?.displayName || user.profile?.email || 'Unknown User';
    const firstName = fullName.split(/\s+/)[0];
    return {
      type: 'user',
      id: userId,
      name: firstName,
      avatarUrl: buildAvatarUrl(user.profile?.avatarUrl),
    };
  }

  /**
   * Get sender info for an agent
   */
  async getAgentSender(
    agentId: string,
  ): Promise<{ type: 'agent'; id: string; name: string; avatarUrl?: string } | null> {
    const agent = await this.agents.findOne({ agentId } as any);
    if (!agent) return null;
    return {
      type: 'agent',
      id: agentId,
      name: agent.name || 'Unknown Agent',
      avatarUrl: buildAvatarUrl(agent.avatarUrl),
    };
  }

  /**
   * Search messages across all user's channels
   * Returns matches grouped by channel with snippets
   * Note: Private channels are excluded from search
   */
  async searchMessages(
    userId: UserId,
    query: string,
    limit: number = 50,
  ): Promise<{
    results: Array<{
      channelId: string;
      channelName: string;
      agentId: string;
      agentName: string;
      matches: Array<{
        messageId: string;
        snippet: string;
        timestamp: string;
        role: 'user' | 'assistant' | 'system';
      }>;
    }>;
    totalMatches: number;
  }> {
    // Get all workspaces the user has access to
    const accessibleWorkspaces = await this.workspaces
      .find({
        status: 'active',
        $or: [{ ownerId: userId }, { 'members.userId': userId }],
      })
      .toArray();
    const workspaceIds = accessibleWorkspaces.map((w) => w.workspaceId);

    // Get all user's channels (global + workspace channels, excluding private ones)
    const userChannels = await this.channels
      .find({
        $or: [
          { userId, workspaceId: { $exists: false } }, // User's global channels
          { workspaceId: { $in: workspaceIds } }, // Channels in accessible workspaces
        ],
        isPrivate: { $ne: true }, // Exclude private channels from search
      } as any)
      .toArray();
    const channelIds = userChannels.map((ch) => ch.channelId);

    if (channelIds.length === 0) {
      return { results: [], totalMatches: 0 };
    }

    // Search messages with text content matching the query
    // Using regex for case-insensitive search
    // Escape special regex characters in query
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedQuery, 'i');

    const matchingMessages = await this.messages
      .find({
        channelId: { $in: channelIds },
        'content.type': 'text',
        'content.text': { $regex: searchRegex },
      } as any)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    // Group matches by channel
    const channelMatches = new Map<
      string,
      Array<{
        messageId: string;
        snippet: string;
        timestamp: string;
        role: 'user' | 'assistant' | 'system';
      }>
    >();

    for (const msg of matchingMessages) {
      const text = (msg.content as any)?.text || '';

      // Create snippet around the match (50 chars before and after)
      const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, matchIndex - 50);
      const end = Math.min(text.length, matchIndex + query.length + 50);
      let snippet = text.substring(start, end);
      if (start > 0) snippet = '...' + snippet;
      if (end < text.length) snippet = snippet + '...';

      const match = {
        messageId: msg.messageId,
        snippet,
        timestamp: msg.timestamp,
        role: msg.role as 'user' | 'assistant' | 'system',
      };

      if (!channelMatches.has(msg.channelId)) {
        channelMatches.set(msg.channelId, []);
      }
      channelMatches.get(msg.channelId)!.push(match);
    }

    // Build results with channel info
    const results: Array<{
      channelId: string;
      channelName: string;
      agentId: string;
      agentName: string;
      matches: Array<{
        messageId: string;
        snippet: string;
        timestamp: string;
        role: 'user' | 'assistant' | 'system';
      }>;
    }> = [];

    for (const [channelId, matches] of channelMatches) {
      const channel = userChannels.find((ch) => ch.channelId === channelId);
      if (!channel) continue;

      // Get agent name
      const agent = await this.agents.findOne({ agentId: channel.agentId } as any);

      results.push({
        channelId,
        channelName: channel.metadata?.name || 'Chat',
        agentId: channel.agentId,
        agentName: agent?.name || agent?.fullName || channel.agentId,
        matches,
      });
    }

    // Sort by most recent match
    results.sort((a, b) => {
      const aTime = a.matches[0]?.timestamp || '';
      const bTime = b.matches[0]?.timestamp || '';
      return bTime.localeCompare(aTime);
    });

    const totalMatches = matchingMessages.length;
    console.log(
      `[ChannelManager] Search "${query}": ${totalMatches} matches in ${results.length} channels`,
    );

    return { results, totalMatches };
  }
}
