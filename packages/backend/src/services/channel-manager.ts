/**
 * Channel Manager
 * Manages channels (conversations) in MongoDB
 */

import { RandomIdGenerator, type IdGenerator } from '@teros/core';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import type {
  AgentId,
  Channel,
  ChannelId,
  ChannelMetadata,
  Message,
  UserId,
} from '@teros/shared';
import type { Collection, Db } from 'mongodb';
import { buildAvatarUrl } from '../lib/avatar-url';
import { isOwnSyntheticTestChannel } from '../lib/mca-test-context';
import { canAccessWorkspace } from '../auth/workspace-access';
import { withTransaction } from '../lib/mongo-transaction';
import { DeletionService } from './deletion-service';

interface Agent {
  agentId: string;
  name: string;
  fullName: string;
  avatarUrl?: string;
  ownerId?: string;
  selectedModelId?: string | null;
  selectedProviderId?: string | null;
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
  lastMessageAt: string;
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
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    // That includes the sort-first `workspaceId_1_lastMessageAt_-1_channelId_1`
    // (NFR-1) behind listUserChannels; message indexes come from migration 20261017_002.
    await ensureCollectionIndexes(this.channels, COLLECTIONS.channels);
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
      scope: 'personal', // REQ-1: new channels are personal by default
      metadata: {
        transport: metadata.transport || 'websocket',
        name: metadata.name || defaultName,
        ...metadata,
      },
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      ...(options?.headless && { headless: true }),
      ...(options?.originChannelId && { originChannelId: options.originChannelId }),
    };

    await this.channels.insertOne(channel as any);
    log.info({ channelId, name: channel.metadata.name, workspaceId }, 'Channel created');

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

    // Channel belongs to a workspace - check workspace access (active membership only)
    if (channel.workspaceId) {
      if (!(await canAccessWorkspace(this.db, userId, channel.workspaceId))) return false;

      // SEC-3 / MUW-REQ-4: another member's channel is only reachable once
      // shared — the same rule listUserChannels applies. A missing scope
      // counts as personal (MUW-NFR-3).
      if (channel.scope !== 'shared') {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * List user's channels with unread counts (paginated)
   * Note: Personal channels are included but marked with scope: 'personal'
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
      // Owned workspaces
      const ownedWorkspaces = await this.workspaces
        .find({ ownerId: userId, status: 'active' })
        .toArray();
      const ownedIds = ownedWorkspaces.map((w) => w.workspaceId);

      // Member workspaces (via workspace_members collection — single source of truth).
      // Pending invitations don't grant access; rows without status are active.
      const memberships = await this.db
        .collection('workspace_members')
        .find({ userId, status: { $ne: 'pending' } })
        .toArray();
      const memberWorkspaceIds = memberships.map((m) => m.workspaceId);

      // Combine and dedupe
      const workspaceIds = [...new Set([...ownedIds, ...memberWorkspaceIds])];

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

    // ─── Visibility filter (REQ-1, REQ-2, NFR-3 rev2) ────────────────────────
    // A user sees:
    //   1. Their own non-public channels (private conversations they created)
    //   2. ALL public channels in the workspace (shared by any member)
    //
    // NFR-3 (revised 2026-09-15 per Pablo's decision): channels without a
    // `scope` field are treated as 'personal' (defense in depth).
    // The migration script backfills all legacy channels with
    // `scope: "personal"`, so no channels should lack the field.
    // But if any slip through, the first $or branch catches them:
    // $ne 'public' is true for undefined, so the owner still sees their
    // own legacy channels. Non-owners do NOT see them — undefined is
    // never treated as 'public'.
    //
    // MUW-REQ-4/5: the scope filter always applies — a member sees their own
    // channels plus the shared ones.
    {
      const scopeFilter = {
        $or: [
          // My own channels that are not public (includes 'private' and undefined)
          { userId, scope: { $ne: 'shared' } },
          // All public channels (explicit 'public' only)
          { scope: 'shared' },
        ],
      };

      // Merge scope filter into baseFilter
      if (baseFilter.$or) {
        // workspaceId=null case already has $or — wrap both in $and
        baseFilter = { $and: [baseFilter, scopeFilter] };
      } else {
        // Specific workspace case — add $or alongside workspaceId
        baseFilter = { ...baseFilter, ...scopeFilter };
      }
    }

    // Apply cursor for keyset pagination (lastMessageAt DESC, channelId ASC as tiebreaker)
    let filter = baseFilter;
    if (options?.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        const cursorCondition = {
          $or: [
            { lastMessageAt: { $lt: decoded.lastMessageAt } },
            { lastMessageAt: decoded.lastMessageAt, channelId: { $gt: decoded.channelId } },
          ],
        };
        // Wrap everything in $and to preserve both the scope $or and cursor $or
        filter = {
          $and: [
            baseFilter,
            cursorCondition,
          ],
        };
      }
    }

    // Fetch one extra to detect if there's a next page
    const rawChannels = await this.channels
      .find(filter)
      .sort({ lastMessageAt: -1, channelId: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = rawChannels.length > limit;
    const pageChannels = rawChannels.slice(0, limit);

    // Build next cursor from the last item of the current page
    let nextCursor: string | null = null;
    if (hasMore && pageChannels.length > 0) {
      const last = pageChannels[pageChannels.length - 1];
      nextCursor = encodeCursor({ lastMessageAt: last.lastMessageAt ?? last.updatedAt, channelId: last.channelId });
    }

    // Agent info (agent + model + provider: 2-4 queries) once per distinct
    // agent on the page, not once per channel — most conversations share a
    // handful of agents (MOD-9 N+1).
    const agentIds = [...new Set(pageChannels.map((c) => c.agentId))];
    const agentInfos = new Map(
      await Promise.all(agentIds.map(async (id) => [id, await this.getAgentInfo(id)] as const)),
    );

    // Unread counts and last-message previews for the whole page in batched
    // aggregations (2-3 queries per page instead of 3 per channel — MOD-9 N+1).
    const [unreadCounts, lastMessages] = await Promise.all([
      this.getUnreadCounts(pageChannels),
      this.getLastMessages(pageChannels.map((c) => c.channelId)),
    ]);

    // Enrich channels with unread counts, last message, agent info, and model
    const enrichedChannels = await Promise.all(
      pageChannels.map(async (channel) => {
        const unreadCount = unreadCounts.get(channel.channelId) ?? 0;
        const lastMessage = lastMessages.get(channel.channelId);
        const agentInfo = agentInfos.get(channel.agentId) ?? null;

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
   * Count unread messages (assistant messages after the channel's lastReadAt,
   * or all of them when it was never read) for a page of channels in one
   * aggregation. Each $or branch is an IXSCAN on {channelId, timestamp}, the
   * same plan the old per-channel countDocuments used. Channels without
   * unread messages are absent from the map (count 0).
   */
  private async getUnreadCounts(
    channels: Array<{ channelId: ChannelId; lastReadAt?: string }>,
  ): Promise<Map<string, number>> {
    if (channels.length === 0) return new Map();

    const rows = await this.messages
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            role: 'assistant',
            $or: channels.map((channel) =>
              channel.lastReadAt
                ? { channelId: channel.channelId, timestamp: { $gt: channel.lastReadAt } }
                : { channelId: channel.channelId },
            ),
          },
        },
        { $group: { _id: '$channelId', count: { $sum: 1 } } },
      ])
      .toArray();

    return new Map(rows.map((row) => [row._id, row.count]));
  }

  /**
   * Last message preview for a page of channels.
   * Prioritizes text messages for better previews; channels without any text
   * message fall back to their most recent message of any type.
   *
   * $sort + $group/$first on an index prefix runs as a DISTINCT_SCAN: one
   * index seek and one document per channel — {channelId, content.type,
   * timestamp} for the text pass, {channelId, timestamp, messageId} for the
   * fallback.
   */
  private async getLastMessages(
    channelIds: ChannelId[],
  ): Promise<Map<string, { content: string; timestamp: string; role?: 'user' | 'assistant' }>> {
    const previews = new Map<
      string,
      { content: string; timestamp: string; role?: 'user' | 'assistant' }
    >();
    if (channelIds.length === 0) return previews;

    // First try to find the last text message for a meaningful preview
    const textMessages = await this.messages
      .aggregate<{ _id: string; message: Message }>([
        { $match: { channelId: { $in: channelIds }, 'content.type': 'text' } },
        { $sort: { channelId: 1, 'content.type': 1, timestamp: -1 } },
        { $group: { _id: '$channelId', message: { $first: '$$ROOT' } } },
      ])
      .toArray();

    for (const { _id, message: textMessage } of textMessages) {
      const content = (textMessage.content as any).text || '';
      const truncated = content.length > 100 ? content.substring(0, 100) + '...' : content;

      previews.set(_id, {
        content: truncated,
        timestamp: textMessage.timestamp,
        role: textMessage.role as 'user' | 'assistant',
      });
    }

    // Fallback to the most recent message of any type
    const withoutText = channelIds.filter((id) => !previews.has(id));
    if (withoutText.length === 0) return previews;

    const lastMessages = await this.messages
      .aggregate<{ _id: string; message: Message }>([
        { $match: { channelId: { $in: withoutText } } },
        { $sort: { channelId: 1, timestamp: -1 } },
        { $group: { _id: '$channelId', message: { $first: '$$ROOT' } } },
      ])
      .toArray();

    for (const { _id, message } of lastMessages) {
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

      previews.set(_id, {
        content,
        timestamp: message.timestamp,
        role: message.role as 'user' | 'assistant',
      });
    }

    return previews;
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
        // System Default = the user's default provider (2-level model,
        // 2026-10-21). No silent fallback to "first by priority": if there is
        // no default the display stays empty, mirroring the runtime resolver.
        const defaultProvider = await this.db.collection('user_providers').findOne(
          { userId, isDefault: true, status: 'active' },
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
   * Close a channel (soft-delete — marks as 'closed', preserves all data)
   *
   * The channel and all its messages remain in the database for history and
   * traceability. The frontend hides closed channels from the active
   * conversation list.
   *
   * NOTE: The previous implementation deleted personal channels permanently
   * (deleteChannelCompletely). That was the original 'incognito' behaviour
   * from Dec 2025, but after MUW made scope:'personal' the default for ALL
   * channels, it became destructive. Removed per Pablo's directive: no
   * conversation data should ever be deleted.
   */
  async closeChannel(channelId: ChannelId): Promise<{ deleted: boolean }> {
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
  async deleteChannelCompletely(channelId: ChannelId, actor = 'system'): Promise<void> {
    // The full cascade lives in DeletionService (INF-3): messages, LLM
    // sessions/compactions, feedback, subscriptions, Automate starters
    // (TER-650/G7), legacy agent_configs, and the channel itself last.
    const report = await new DeletionService(this.db).deleteChannel(channelId, actor);
    log.info({ channelId, report }, 'Channel completely deleted');
  }

  /**
   * Set channel scope (personal ↔ shared) — REQ-2.
   * Controls which workspace members can see the channel in their list.
   */
  async setChannelScope(channelId: ChannelId, scope: 'personal' | 'shared'): Promise<void> {
    const now = new Date().toISOString();
    await this.channels.updateOne({ channelId } as any, {
      $set: {
        scope,
        updatedAt: now,
      },
    });
    log.info({ channelId, scope }, 'Channel scope updated');
  }

  /**
   * Toggle redaction on a message — REQ-4.
   *
   * Sets redacted/redactedBy/redactedAt on the message document.
   * When redacted is true, the message content is replaced with a placeholder
   * for non-owners (enforced in redact-messages.ts).
   * When redacted is false (un-redact), the content becomes visible again.
   *
   * @returns The updated message, or null if the message was not found.
   */
  async toggleMessageRedaction(
    channelId: ChannelId,
    messageId: string,
    redacted: boolean,
    redactedBy: string,
  ): Promise<Message | null> {
    const now = new Date().toISOString();

    if (redacted) {
      await this.messages.updateOne(
        { channelId, messageId } as any,
        {
          $set: {
            redacted: true,
            redactedBy,
            redactedAt: now,
          },
        },
      );
    } else {
      // Un-redact: clear the redaction fields
      await this.messages.updateOne(
        { channelId, messageId } as any,
        {
          $set: { redacted: false },
          $unset: { redactedBy: "", redactedAt: "" },
        },
      );
    }

    // MUW-F1: Propagate the redaction flag to session_messages (LLM context collection).
    // Strategy: read the channel message to check for a turnId. If present, flag ALL
    // session docs for that turn (channelMessageId === turnId) — whole-turn flagging.
    // Over-redaction is the safe direction for security. Fall back to matching by
    // channelMessageId === messageId OR info.id === messageId (legacy, pre-turnId).
    // Uses updateMany because assistant messages can appear as multiple session_messages
    // docs (parts-splitting).
    const channelMsg = await this.messages.findOne({ channelId, messageId } as any);
    const turnId = channelMsg?.turnId;
    const sessionMessages = this.db.collection('session_messages');
    const sessionFilter = turnId
      ? {
          sessionId: channelId,
          $or: [
            { 'info.channelMessageId': turnId },
            { 'info.channelMessageId': messageId },
            { 'info.id': messageId },
          ],
        }
      : {
          sessionId: channelId,
          $or: [
            { 'info.channelMessageId': messageId },
            { 'info.id': messageId },
          ],
        };
    if (redacted) {
      await sessionMessages.updateMany(
        sessionFilter as any,
        {
          $set: {
            'info.redacted': true,
            'info.redactedBy': redactedBy,
            'info.redactedAt': now,
          },
        },
      );
    } else {
      await sessionMessages.updateMany(
        sessionFilter as any,
        {
          $set: { 'info.redacted': false },
          $unset: { 'info.redactedBy': '', 'info.redactedAt': '' },
        },
      );
    }

    const updated = await this.messages.findOne({ channelId, messageId } as any);
    log.info({ channelId, messageId, redacted, redactedBy }, "Message redaction toggled");
    return updated as Message | null;
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
   * Rename a channel.
   *
   * A channel linked to a board task (task.channelId) CANNOT be renamed:
   * its title is the task's title by invariant — rename the task instead
   * (BoardService.updateTask syncs the linked channel). Enforced here so
   * every rename path is covered: MCA tool, WS handler, autoname.
   */
  async renameChannel(channelId: ChannelId, name: string): Promise<void> {
    // Block task-linked channels — the task owns the title. Strict: any task
    // (active or archived) holding the channelId link blocks the rename, so the
    // "task title = conversation title" invariant can never drift.
    const linkedTask = await this.db.collection('tasks').findOne({ channelId });
    if (linkedTask) {
      throw new Error(
        `This conversation is linked to the task "${linkedTask.title || linkedTask.taskId}" — rename the task, not the conversation`,
      );
    }

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
   * Persist contextual follow-up prompts on the channel (composer suggestions).
   * Regenerated after every agent response; empty array clears them.
   */
  async setSuggestedPrompts(channelId: ChannelId, prompts: string[]): Promise<void> {
    const now = new Date().toISOString();
    await this.channels.updateOne({ channelId } as any, {
      $set: {
        'metadata.suggestedPrompts': prompts,
        updatedAt: now,
      },
    });
    log.info({ channelId, count: prompts.length }, 'Channel suggested prompts updated');
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
   * Save message to database
   */
  async saveMessage(message: Message): Promise<void> {
    // Message + channel ordering fields in one transaction when available
    // (MOD-4). $max keeps them monotonic: a late or out-of-order write can no
    // longer move the conversation back in the list.
    //
    // Every message carries its channel's workspaceId: the future shard key
    // (docs/architecture/sharding-by-workspace.md). Callers rarely have it at
    // hand, so it is resolved from the channel (one indexed point read).
    await withTransaction(this.db, async (session) => {
      let workspaceId: string | undefined = (message as any).workspaceId;
      if (!workspaceId) {
        const channel = await this.channels.findOne(
          { channelId: message.channelId } as any,
          { projection: { workspaceId: 1 }, session },
        );
        workspaceId = (channel as any)?.workspaceId ?? undefined;
      }
      const doc = workspaceId ? { ...message, workspaceId } : message;
      await this.messages.insertOne(doc as any, { session });
      await this.channels.updateOne(
        { channelId: message.channelId } as any,
        { $max: { updatedAt: message.timestamp, lastMessageAt: message.timestamp } },
        { session },
      );
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
   * Field-level $set on `metadata.*` (same contract as
   * updateMessageContentFields — never clobbers sibling metadata).
   */
  async updateMessageMetadataFields(
    messageId: string,
    fields: Record<string, any>,
  ): Promise<void> {
    const update: Record<string, any> = {};
    for (const [key, value] of Object.entries(fields)) {
      update[`metadata.${key}`] = value;
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
      // Cursor message, looked up in THIS channel. Messages sharing the
      // cursor's timestamp are ordered by messageId (MOD-9: filtering only on
      // timestamp < cursor skipped them).
      const beforeMessage = await this.messages.findOne({ messageId: before, channelId } as any);
      if (beforeMessage) {
        filter.$or = [
          { timestamp: { $lt: beforeMessage.timestamp } },
          { timestamp: beforeMessage.timestamp, messageId: { $lt: beforeMessage.messageId } },
        ];
      }
    }

    // Served by channel_messages {channelId, timestamp desc, messageId desc}
    const messages = await this.messages
      .find(filter)
      .sort({ timestamp: -1, messageId: -1 })
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
   * Search messages across all channels visible to the user
   * Returns matches grouped by channel with snippets
   *
   * Visibility follows the same model as listUserChannels: the user's own
   * conversations (personal + legacy without scope) plus every shared
   * conversation in the workspaces they belong to.
   *
   * @param options.includePersonal - When false, personal conversations are
   *   excluded. Callers running inside a shared conversation MUST pass false:
   *   the owner's personal history would otherwise leak into a
   *   workspace-visible context. Defaults to true (user-facing search).
   */
  async searchMessages(
    userId: UserId,
    query: string,
    limit: number = 50,
    options?: { includePersonal?: boolean },
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
    // ─── Search policy (documented per task spec) ────────────────────────────
    // - Per-channel cap: MAX_MATCHES_PER_CHANNEL prevents one hot conversation
    //   from eating the whole global limit and hiding every other channel.
    // - Channel cap: MAX_CHANNELS cap keeps the payload bounded.
    // - Multi-word: query is split on whitespace; a message must contain ALL
    //   words (order-independent). Implemented as $and of per-word regexes.
    // - Title search: channels whose metadata.name matches are included even
    //   if no message matches, with a synthetic title-match snippet.
    // - totalMatches: real count via countDocuments with the same filter —
    //   not truncated by `limit`.
    // - Regex vs $text: we keep case-insensitive $regex on content.text.
    //   A $text index would give stemming + ranking but loses substring
    //   matching (e.g. "port" matching "portal") and forces exact-token
    //   semantics that feel broken in a chat UI. The channelId+timestamp
    //   indexes bound the scan per channel, so the regex cost is acceptable
    //   at current scale. Revisit if message volume grows an order of
    //   magnitude.
    const MAX_MATCHES_PER_CHANNEL = 5;
    const MAX_CHANNELS = 20;

    // Get all workspaces the user has access to
    const ownedWorkspaces = await this.workspaces
      .find({ ownerId: userId, status: 'active' })
      .toArray();
    const ownedIds = ownedWorkspaces.map((w) => w.workspaceId);

    // Member workspaces (via workspace_members collection — single source of truth).
    const memberships = await this.db
      .collection('workspace_members')
      .find({ userId, status: { $ne: 'pending' } })
      .toArray();
    const memberWorkspaceIds = memberships.map((m) => m.workspaceId);

    const workspaceIds = [...new Set([...ownedIds, ...memberWorkspaceIds])];

    const includePersonal = options?.includePersonal !== false;
    const scopeFilter = includePersonal
      ? { $or: [{ userId, scope: { $ne: 'shared' } }, { scope: 'shared' }] }
      : { scope: 'shared' };
    const userChannels = await this.channels
      .find({ workspaceId: { $in: workspaceIds }, ...scopeFilter } as any)
      .toArray();
    const channelIds = userChannels.map((ch) => ch.channelId);

    if (channelIds.length === 0) {
      return { results: [], totalMatches: 0 };
    }

    // Split query into words for multi-word AND matching. Single-word queries
    // behave exactly as before (one regex).
    const words = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    if (words.length === 0) {
      return { results: [], totalMatches: 0 };
    }

    const wordRegexes = words.map((w) => new RegExp(w, 'i'));

    // MUW-NFR-2: redacted messages never surface through search.
    // Build message filter: all words must appear in content.text (AND).
    const textConditions = wordRegexes.map((re) => ({ 'content.text': { $regex: re } }));
    const searchQuery: any = {
      channelId: { $in: channelIds },
      'content.type': 'text',
      ...(textConditions.length === 1
        ? textConditions[0]
        : { $and: textConditions }),
    };
    searchQuery.redacted = { $ne: true };

    // Real total (not truncated by limit) + capped message fetch, in parallel.
    const [totalMatches, matchingMessages] = await Promise.all([
      this.messages.countDocuments(searchQuery as any),
      this.messages
        .find(searchQuery as any)
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray(),
    ]);

    // Group matches by channel with per-channel cap.
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
      const existing = channelMatches.get(msg.channelId);
      if (existing && existing.length >= MAX_MATCHES_PER_CHANNEL) continue;

      const text = (msg.content as any)?.text || '';

      // Snippet around the FIRST word that matches (deterministic enough for UI).
      const lower = text.toLowerCase();
      let matchIndex = -1;
      let matchLen = query.length;
      for (const w of words) {
        const idx = lower.indexOf(w.toLowerCase());
        if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
          matchIndex = idx;
          matchLen = w.length;
        }
      }
      if (matchIndex === -1) {
        matchIndex = 0;
        matchLen = Math.min(query.length, text.length);
      }
      const start = Math.max(0, matchIndex - 50);
      const end = Math.min(text.length, matchIndex + matchLen + 50);
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

    // Title matches: channels whose name matches ALL words but had no message
    // matches. Uses the already-loaded userChannels — no extra query.
    const titleMatchChannelIds = new Set<string>();
    for (const ch of userChannels) {
      if (channelMatches.has(ch.channelId)) continue;
      const name = (ch.metadata?.name || '').toLowerCase();
      if (!name) continue;
      const allWordsInTitle = words.every((w) => name.includes(w.toLowerCase()));
      if (allWordsInTitle) {
        titleMatchChannelIds.add(ch.channelId);
      }
    }

    // Collect all agentIds we need (message-match channels + title-match channels).
    const involvedChannelIds = [
      ...new Set([...channelMatches.keys(), ...titleMatchChannelIds]),
    ].slice(0, MAX_CHANNELS);

    const involvedChannels = involvedChannelIds
      .map((id) => userChannels.find((ch) => ch.channelId === id))
      .filter((ch): ch is NonNullable<typeof ch> => Boolean(ch));

    const agentIds = [...new Set(involvedChannels.map((ch) => ch.agentId).filter(Boolean))];

    // Single find for all agents — kills the N+1.
    const agents = agentIds.length
      ? await this.agents.find({ agentId: { $in: agentIds } } as any).toArray()
      : [];
    const agentById = new Map(agents.map((a: any) => [a.agentId, a]));

    // Build results.
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

    for (const channel of involvedChannels) {
      const agent: any = agentById.get(channel.agentId);
      const channelName = channel.metadata?.name || 'Chat';
      const agentName = agent?.name || agent?.fullName || channel.agentId;

      const messageMatches = channelMatches.get(channel.channelId) || [];

      if (messageMatches.length > 0) {
        results.push({
          channelId: channel.channelId,
          channelName,
          agentId: channel.agentId,
          agentName,
          matches: messageMatches,
        });
      } else if (titleMatchChannelIds.has(channel.channelId)) {
        // Synthetic title match so the UI has something to show.
        results.push({
          channelId: channel.channelId,
          channelName,
          agentId: channel.agentId,
          agentName,
          matches: [
            {
              messageId: '',
              snippet: channelName,
              timestamp: channel.updatedAt || channel.createdAt || '',
              role: 'system' as const,
            },
          ],
        });
      }
    }

    // Sort by most recent match.
    results.sort((a, b) => {
      const aTime = a.matches[0]?.timestamp || '';
      const bTime = b.matches[0]?.timestamp || '';
      return bTime.localeCompare(aTime);
    });

    log.debug(
      { query, totalMatches, channels: results.length, titleMatches: titleMatchChannelIds.size },
      'Channel search results',
    );

    return { results, totalMatches };
  }

  /**
   * Move a channel (conversation) from one workspace to another.
   *
   * Updates the `workspaceId` on the channel document and on its messages,
   * which carry it as the future shard key (docs/architecture/sharding-by-workspace.md).
   * The channel moves first: a crash in between leaves messages behind with the
   * old workspaceId, and re-running the move fixes them.
   *
   * Edge cases handled:
   * - Agent may not exist in the target workspace → returned as a warning
   *   (the conversation still moves; the agent assignment is preserved).
   * - Board task linked via `channelId` → returned as a warning. The task
   *   stays in its original board/project; the caller may want to unlink it.
   *
   * @returns The updated channel plus warnings about agent / board task.
   */
  async moveChannelToWorkspace(
    channelId: ChannelId,
    targetWorkspaceId: string,
  ): Promise<{
    channel: Channel | null;
    warnings: string[];
  }> {
    const channel = await this.getChannel(channelId);
    if (!channel) {
      return { channel: null, warnings: [] };
    }

    const sourceWorkspaceId = channel.workspaceId;
    const warnings: string[] = [];

    // Nothing to do if already in the target workspace
    if (sourceWorkspaceId === targetWorkspaceId) {
      await this.messages.updateMany(
        { channelId, workspaceId: { $ne: targetWorkspaceId } } as any,
        { $set: { workspaceId: targetWorkspaceId } },
      );
      return { channel, warnings: ['Channel is already in the target workspace'] };
    }

    const now = new Date().toISOString();

    // Check if the channel's agent exists in the target workspace
    const agent = await this.agents.findOne({ agentId: channel.agentId } as any);
    if (agent) {
      const agentWorkspaceId = (agent as any).workspaceId;
      if (agentWorkspaceId && agentWorkspaceId !== targetWorkspaceId) {
        warnings.push(
          `Agent "${agent.name || channel.agentId}" is not in the target workspace. ` +
            `The conversation will still work, but the agent may not have access to ` +
            `workspace-scoped resources (apps, files, etc.) in the new workspace.`,
        );
      }
    }

    // Check if there is a board task linked to this channel (tasks live in
    // `tasks`; `board_tasks` never existed, so this warning could never fire — MOD-1)
    const tasks = this.db.collection('tasks');
    const linkedTask = await tasks.findOne({ channelId });
    if (linkedTask) {
      warnings.push(
        `This conversation is linked to board task "${linkedTask.title || linkedTask.taskId}". ` +
          `The task remains in its original board. Consider unlinking it if the task ` +
          `should follow the conversation to the new workspace.`,
      );
    }

    // Update the channel's workspaceId
    const result = await this.channels.findOneAndUpdate(
      { channelId },
      {
        $set: {
          workspaceId: targetWorkspaceId,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );

    if (!result) {
      return { channel: null, warnings };
    }

    await this.messages.updateMany(
      { channelId, workspaceId: { $ne: targetWorkspaceId } } as any,
      { $set: { workspaceId: targetWorkspaceId } },
    );

    log.info(
      { channelId, sourceWorkspaceId, targetWorkspaceId, warnings: warnings.length },
      'Channel moved to new workspace',
    );

    return { channel: result, warnings };
  }
}
