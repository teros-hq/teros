/**
 * Channel Manager
 * Manages channels (conversations) in MongoDB
 */

import { RandomIdGenerator, type IdGenerator } from '@teros/core';
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
import { buildAvatarUrl } from '../lib/avatar-url';
import { isOwnSyntheticTestChannel } from '../lib/mca-test-context';

interface Agent {
  agentId: string;
  name: string;
  fullName: string;
  avatarUrl?: string;
  ownerId?: string;
  selectedModelId?: string | null;
  selectedProviderId?: string | null;
  availableProviders?: string[];
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

import { createLogger } from '../lib/logger';

const log = createLogger('ChannelManager');

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
  private models: Collection<any>;
  private workspaces: Collection<Workspace>;
  private users: Collection<any>;
  private internalLLM: InternalLLMService;
  /** Generadores de IDs forkeados por dominio — deterministas en modo test (TER-563). */
  private readonly channelIds: IdGenerator;
  private readonly messageIds: IdGenerator;

  constructor(
    private db: Db,
    private providerService: ProviderService,
    idGenerator: IdGenerator = new RandomIdGenerator(),
  ) {
    this.channelIds = idGenerator.fork('ch');
    this.messageIds = idGenerator.fork('msg');
    this.channels = db.collection<Channel>('channels');
    this.agentConfigs = db.collection<AgentConfig>('agent_configs');
    this.userApps = db.collection<UserApp>('user_apps');
    this.messages = db.collection<Message>('channel_messages');
    this.agents = db.collection<Agent>('agents');
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

    log.debug('ChannelManager indexes ensured');
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
    // Note: || is intentional (not ??): null workspaceId (Superagent) is treated as falsy → undefined
    let workspaceId: string | undefined;
    let workspaceIdSource: 'explicit' | 'agent' | 'none';
    if (options?.workspaceId) {
      workspaceId = options.workspaceId;
      workspaceIdSource = 'explicit';
    } else if ((agent as any)?.workspaceId) {
      workspaceId = (agent as any).workspaceId;
      workspaceIdSource = 'agent';
    } else {
      workspaceId = undefined;
      workspaceIdSource = 'none';
    }
    log.debug({ workspaceIdSource, workspaceId }, 'Channel workspaceId resolved');

    // INVARIANT: every channel must have a workspaceId (ENGINEERING-PRINCIPLES.md)
    if (!workspaceId) {
      throw new Error(
        `[ChannelManager.createChannel] FATAL: Cannot create channel without workspaceId. ` +
        `agentId=${agentId}, userId=${userId}. ` +
        `All channels must belong to a workspace.`
      );
    }

    const channel: Channel = {
      channelId,
      userId,
      agentId,
      status: 'active',
      workspaceId,
      metadata: {
        transport: metadata.transport || 'websocket',
        name: metadata.name || defaultName,
        ...metadata,
      },
      createdAt: now,
      updatedAt: now,
      ...(options?.headless && { headless: true }),
      ...(options?.originChannelId && { originChannelId: options.originChannelId }),
    };

    await this.channels.insertOne(channel as any);
    log.info({ channelId, name: channel.metadata.name, workspaceId }, 'Channel created');

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
  async canAccessChannel(channelId: ChannelId, userId: UserId, agentId?: string): Promise<boolean> {
    // The admin MCA test path scopes context-requiring tools to a synthetic per-user channel that
    // has no real record. Grant the caller access to their OWN test channel so channel-authorizing
    // tools (e.g. board-manager list-event-subscriptions) run against an isolated namespace instead
    // of a FORBIDDEN. Scoped to the matching userId — never another user's fabricated channel.
    //
    // This shared primitive is called by ~12 handlers (subscribe-to-events, channel/get, …) with a
    // CLIENT-SUPPLIED channelId, so the grant is re-gated to system admins here. Without it any
    // authenticated user could forge channelId="test-channel:<own userId>" and be authorized against
    // a channel that never existed — the feature is admin-only (app.test-mca-tool → requireSystemAdmin),
    // so the same gate must hold in the primitive. The DB lookup only runs for the synthetic id shape,
    // which real channels never use, so the normal authz path is untouched.
    if (isOwnSyntheticTestChannel(channelId, userId)) {
      const user = await this.users.findOne({ userId });
      return user?.role === 'admin' || user?.role === 'super';
    }

    const channel = await this.getChannel(channelId);
    if (!channel) return false;

    // User is the channel owner
    if (channel.userId === userId) return true;

    // Agent is the assigned agent for this channel
    if (agentId && channel.agentId === agentId) return true;

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
   *   - null/undefined: all channels in accessible workspaces
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

    if (options?.workspaceId === null || options?.workspaceId === undefined) {
      // Return ALL channels in accessible workspaces
      const accessibleWorkspaces = await this.workspaces
        .find({
          status: 'active',
          $or: [{ ownerId: userId }, { 'members.userId': userId }],
        })
        .toArray();

      const workspaceIds = accessibleWorkspaces.map((w) => w.workspaceId);

      baseFilter = {
        workspaceId: { $in: workspaceIds },
      };
    } else {
      // Specific workspace only
      baseFilter = { workspaceId: options.workspaceId };
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

    log.debug({ count: enrichedChannels.length, hasMore }, 'channel.list page');

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
      log.warn({ agentId }, 'Agent not found');
      return null;
    }

    // Get model from agent's selectedModelId (not from agent_core, which is legacy)
    let modelString: string | undefined;
    let modelName: string | undefined;
    let providerName: string | undefined;
    
    if (agent.selectedModelId) {
      // Explicit model selected — resolve from global models collection
      const model = await this.models.findOne({ modelId: agent.selectedModelId } as any);
      if (model) {
        modelString = model.modelString;
        // Strip provider suffix from model name (e.g., "Claude Sonnet 4.5 (OpenRouter)" → "Claude Sonnet 4.5")
        modelName = (model.name || '').replace(/\s*\([^)]+\)\s*$/, '').trim() || model.name;
      } else {
        // Not found in global models — use modelId as fallback
        modelString = agent.selectedModelId;
      }

      // Get provider display name from explicit selectedProviderId
      if (agent.selectedProviderId) {
        const userProvider = await this.db.collection('user_providers').findOne({ 
          providerId: agent.selectedProviderId 
        } as any);
        if (userProvider) {
          providerName = userProvider.displayName;
        }
      }
    } else {
      // No explicit model — agent uses system default provider
      // Resolve the user's default provider to show what model will actually be used
      const userId = agent.ownerId;
      if (userId) {
        // Try isDefault first, then fall back to first by priority
        const defaultProvider = await this.db.collection('user_providers').findOne(
          { userId, isDefault: true, status: 'active' },
        ) ?? await this.db.collection('user_providers').findOne(
          { userId, status: 'active' },
          { sort: { priority: 1 } },
        );

        if (defaultProvider) {
          providerName = defaultProvider.displayName;

          // Resolve the model: defaultModelId or first model
          const resolvedModelId = defaultProvider.defaultModelId || defaultProvider.models?.[0]?.modelId;
          if (resolvedModelId) {
            const model = await this.models.findOne({ modelId: resolvedModelId } as any);
            if (model) {
              modelString = model.modelString;
              modelName = (model.name || '').replace(/\s*\([^)]+\)\s*$/, '').trim() || model.name;
            } else {
              modelString = resolvedModelId;
            }
          }
        }
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
   * Set the running state of a channel.
   * Called at the start of every agent turn (running=true) and in the finally block (running=false).
   * When running=true, also records runningAt = now (ISO timestamp).
   * When running=false, clears runningAt.
   */
  async setRunning(channelId: ChannelId, running: boolean): Promise<void> {
    const now = new Date().toISOString();
    if (running) {
      await this.channels.updateOne({ channelId } as any, {
        $set: { running: true, runningAt: now },
      });
    } else {
      await this.channels.updateOne({ channelId } as any, {
        $set: { running: false },
        $unset: { runningAt: '' },
      });
    }
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

    log.debug({ channelId }, 'Channel marked as read');
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
    log.info({ channelId }, 'Channel closed');
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

    // 3. Delete scheduler tasks bound to this channel (TER-650/G7). A recurring
    //    task / reminder must not outlive its channel: otherwise the scheduler
    //    keeps firing it every cron slot (failing ownership) until the failure
    //    cap disables it — wasted dispatches and a stray heartbeat. Root cause:
    //    the task's lifetime is bounded by its channel's.
    const [recurringDeleted, remindersDeleted] = await Promise.all([
      this.db.collection('scheduler_recurring_tasks').deleteMany({ channel_id: channelId }),
      this.db.collection('scheduler_reminders').deleteMany({ channel_id: channelId }),
    ]);

    // 4. Delete channel
    await this.channels.deleteOne({ channelId } as any);

    log.info(
      {
        channelId,
        messagesDeleted: messagesResult.deletedCount,
        recurringTasksDeleted: recurringDeleted.deletedCount,
        remindersDeleted: remindersDeleted.deletedCount,
      },
      'Private channel completely deleted',
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
    log.info({ channelId, isPrivate }, 'Channel privacy updated');
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
      log.info({ deletedCount }, 'Cleaned up expired private channels');
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
    log.info({ channelId }, 'Channel reopened');
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
    log.info({ channelId, name }, 'Channel renamed');
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
      log.info({ channelId, defaultName }, 'Channel reset to default name');
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
      log.info({ channelId, generatedName }, 'Channel auto-named');

      return generatedName;
    } catch (error) {
      log.error({ err: error, channelId }, 'Error auto-naming channel');
      return null;
    }
  }

  /**
   * Get a single channel enriched with agent info, in the same flat format
   * returned by listUserChannels. Used by channel.get handler so the frontend
   * can consume it identically to channel.list entries.
   */
  async getEnrichedChannel(channelId: ChannelId): Promise<Channel | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    const agentInfo = channel.agentId ? await this.getAgentInfo(channel.agentId) : null;

    return {
      ...channel,
      agentName: agentInfo?.agentName,
      agentAvatarUrl: agentInfo?.avatarUrl,
      modelString: agentInfo?.modelString,
      modelName: agentInfo?.modelName,
      providerName: agentInfo?.providerName,
    } as Channel;
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
   * Field-level $set on `content.*`. Unlike `updateMessageContent` this does
   * not replace the whole content object, so callers that only know part of
   * the record (e.g. a status transition) can write without clobbering the
   * fields persisted by whoever created the message.
   */
  async updateMessageContentFields(
    messageId: string,
    fields: Record<string, any>,
  ): Promise<void> {
    const update: Record<string, any> = {};
    for (const [key, value] of Object.entries(fields)) {
      update[`content.${key}`] = value;
    }
    await this.messages.updateOne({ messageId } as any, { $set: update });
  }

  /**
   * Bump the message's `timestamp` to `Date.now()`. Used when a queued
   * user message transitions to `running` — the chat is sorted by
   * timestamp, so without this bump a reload would lay the bubbles in
   * send-time order (all queued items share the same minute) instead of
   * processing order.
   */
  async touchMessageTimestamp(messageId: string): Promise<void> {
    await this.messages.updateOne(
      { messageId } as any,
      { $set: { timestamp: new Date().toISOString() } },
    );
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
    return `ch_${this.channelIds.hex16()}` as ChannelId;
  }

  /**
   * Generate unique message ID
   */
  createMessageId(): string {
    return `msg_${this.messageIds.hex16()}`;
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

    // Get all user's channels in accessible workspaces (excluding private ones)
    const userChannels = await this.channels
      .find({
        workspaceId: { $in: workspaceIds },
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
    log.debug({ query, totalMatches, channels: results.length }, 'Channel search results');

    return { results, totalMatches };
  }
}
