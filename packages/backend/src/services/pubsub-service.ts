/**
 * PubSubService — Unified Pub/Sub Layer
 *
 * Replaces the 7 fragmented pub/sub mechanisms in the Teros backend:
 *
 * 1. In-memory WebSocket session subscriptions (topics: channel:*, board:*, file:*)
 *    - Replaces: SessionManager.subscribedChannels / subscribedBoards
 *    - Replaces: SubscriptionManager (file:{path})
 *
 * 2. Persistent channel-to-channel subscriptions (MongoDB)
 *    - Replaces: originChannelId as a fanout mechanism
 *    - Allows N-to-N observers, survives backend restarts
 *
 * 3. Virtual listeners (in-memory callbacks for voice handler)
 *    - Replaces: SessionManager.channelListeners
 *
 * StreamPublisher (#6 in the audit) is NOT unified here — it is ephemeral by design.
 * originChannelId on Channel documents is NOT removed — it remains as a structural field.
 */

import type { WebSocket } from 'ws';
import type { Db } from 'mongodb';
import type { UserId } from '@teros/shared';
import { getChannelSubscriptionsCollection } from '../models/channel-subscriptions';
import type { ScheduledEvent } from '../handlers/event-handler';
import type { SessionManager } from './session-manager';
import type { WorkspaceService } from './workspace-service';
import { createLogger } from '../lib/logger';

const log = createLogger('PubSubService');

// ============================================================================
// TYPES
// ============================================================================

export type ChannelMessageListener = (message: string) => void;

/**
 * A lightweight WebSocket session reference — only the fields PubSubService needs.
 */
export interface PubSubSession {
  sessionId: string;
  ws: WebSocket;
}

// ============================================================================
// PUBSUB SERVICE
// ============================================================================

export class PubSubService {
  // --------------------------------------------------------------------------
  // In-memory: topic → Set<sessionId>
  // --------------------------------------------------------------------------
  private topicSessions = new Map<string, Set<string>>(); // topic → sessionIds
  private sessionTopics = new Map<string, Set<string>>();  // sessionId → topics

  // --------------------------------------------------------------------------
  // In-memory: sessionId → PubSubSession (for ws access)
  // --------------------------------------------------------------------------
  private sessionMap = new Map<string, PubSubSession>();

  // --------------------------------------------------------------------------
  // In-memory: channelId → Set<ChannelMessageListener> (virtual listeners)
  // --------------------------------------------------------------------------
  private channelListeners = new Map<string, Set<ChannelMessageListener>>();

  // Global channel listeners — invoked for EVERY channel broadcast, regardless
  // of channelId. Used by the Terminal bridge to route events to G2 Terminal
  // providers without needing per-channel registration.
  // --------------------------------------------------------------------------
  private globalChannelListeners = new Set<(channelId: string, message: string) => void>();

  // --------------------------------------------------------------------------
  // Lazy EventHandler reference (set after construction to avoid circular deps)
  // --------------------------------------------------------------------------
  private eventHandlerFn?: (event: ScheduledEvent) => Promise<{ success: boolean; error?: string }>;

  // --------------------------------------------------------------------------
  // Lazy SessionManager + WorkspaceService references (set after construction
  // to avoid circular deps). Required by broadcastToUser / broadcastToWorkspace.
  // --------------------------------------------------------------------------
  private sessionManager?: SessionManager;
  private workspaceService?: WorkspaceService;

  constructor(private db: Db) {}

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Call once at startup. The channel_subscriptions indexes are applied by
   * ensureAllIndexes after migrations (src/db/indexes.ts, GOV-4).
   */
  async init(): Promise<void> {
    console.log('[PubSubService] Initialized');
  }

  /**
   * Inject the EventHandler's handleScheduledEvent function.
   * Called from bootstrap after both services are created.
   */
  setEventHandler(fn: (event: ScheduledEvent) => Promise<{ success: boolean; error?: string }>): void {
    this.eventHandlerFn = fn;
  }

  /**
   * Inject SessionManager. Required by broadcastToUser / broadcastToWorkspace.
   * Called from bootstrap after both services are created.
   */
  setSessionManager(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
  }

  /**
   * Inject WorkspaceService. Required by broadcastToWorkspace.
   * Called from bootstrap after both services are created.
   */
  setWorkspaceService(workspaceService: WorkspaceService): void {
    this.workspaceService = workspaceService;
  }

  // ============================================================================
  // SESSION REGISTRY
  // ============================================================================

  /**
   * Register a session so PubSubService can look up its WebSocket.
   * Call this when a WebSocket session is created.
   */
  registerSession(sessionId: string, ws: WebSocket): void {
    this.sessionMap.set(sessionId, { sessionId, ws });
    this.sessionTopics.set(sessionId, new Set());
  }

  /**
   * Unregister a session and clean up all its topic subscriptions.
   * Call this when a WebSocket session is removed.
   */
  unregisterSession(sessionId: string): void {
    const topics = this.sessionTopics.get(sessionId);
    if (topics) {
      for (const topic of topics) {
        this.topicSessions.get(topic)?.delete(sessionId);
        if (this.topicSessions.get(topic)?.size === 0) {
          this.topicSessions.delete(topic);
        }
      }
    }
    this.sessionTopics.delete(sessionId);
    this.sessionMap.delete(sessionId);
  }

  // ============================================================================
  // IN-MEMORY: TOPIC SUBSCRIPTIONS (WebSocket sessions)
  // ============================================================================

  /**
   * Subscribe a WebSocket session to a topic.
   * Topics: "channel:{channelId}", "board:{boardId}", "file:{volumeHash}:{filePath}" (fileWatchTopic)
   */
  subscribeSession(sessionId: string, topic: string): void {
    // Ensure session is registered
    if (!this.sessionTopics.has(sessionId)) {
      this.sessionTopics.set(sessionId, new Set());
    }

    if (!this.topicSessions.has(topic)) {
      this.topicSessions.set(topic, new Set());
    }

    this.topicSessions.get(topic)!.add(sessionId);
    this.sessionTopics.get(sessionId)!.add(topic);

    console.log(`[PubSubService] Session ${sessionId} subscribed to topic "${topic}"`);
  }

  /**
   * Unsubscribe a WebSocket session from a topic.
   */
  unsubscribeSession(sessionId: string, topic: string): void {
    this.topicSessions.get(topic)?.delete(sessionId);
    if (this.topicSessions.get(topic)?.size === 0) {
      this.topicSessions.delete(topic);
    }
    this.sessionTopics.get(sessionId)?.delete(topic);
  }

  /**
   * Broadcast a JSON event to all WebSocket sessions subscribed to a topic.
   * Also notifies virtual listeners for "channel:{channelId}" topics.
   */
  broadcastToTopic(topic: string, event: Record<string, unknown>): void {
    const sessionIds = this.topicSessions.get(topic);
    const payload = JSON.stringify(event);
    let sentCount = 0;
    let closedCount = 0;

    if (sessionIds && sessionIds.size > 0) {
      for (const sessionId of sessionIds) {
        const session = this.sessionMap.get(sessionId);
        if (!session) continue;
        if (session.ws.readyState === 1) { // OPEN
          session.ws.send(payload);
          sentCount++;
        } else {
          closedCount++;
        }
      }
    }

    // Also notify virtual listeners if this is a channel topic
    if (topic.startsWith('channel:')) {
      const channelId = topic.slice('channel:'.length);
      const listeners = this.channelListeners.get(channelId);
      if (listeners) {
        for (const listener of listeners) {
          try {
            listener(payload);
            sentCount++;
          } catch (err) {
            console.error(`[PubSubService] Error in listener for ${topic}:`, err);
          }
        }
      }
      // Global listeners — invoked for every channel broadcast
      for (const globalListener of this.globalChannelListeners) {
        try {
          globalListener(channelId, payload);
        } catch (err) {
          console.error(`[PubSubService] Error in global listener:`, err);
        }
      }
    }

    if (sentCount === 0 && closedCount === 0) {
      // No subscribers — fires on every broadcast without an active WS session
      // (agents polling topics, etc.). Was a raw console.log and dominated the
      // out log (~27k lines per 100MB); the comment above always said "debug
      // level only" — now it actually is.
      log.debug(`No subscribers for topic "${topic}"`);
    } else {
      log.debug(
        `Broadcast to topic "${topic}": ${sentCount} sent, ${closedCount} closed`,
      );
    }
  }

  /**
   * Get all sessions subscribed to a topic (for backwards compat with SessionManager callers).
   */
  getTopicSessions(topic: string): PubSubSession[] {
    const sessionIds = this.topicSessions.get(topic);
    if (!sessionIds || sessionIds.size === 0) return [];
    const result: PubSubSession[] = [];
    for (const id of sessionIds) {
      const s = this.sessionMap.get(id);
      if (s) result.push(s);
    }
    return result;
  }

  /**
   * Get all topics a session is subscribed to.
   */
  getSessionTopics(sessionId: string): string[] {
    return Array.from(this.sessionTopics.get(sessionId) ?? []);
  }

  // ============================================================================
  // IDENTITY-SCOPED BROADCAST (user / workspace fan-out)
  // ============================================================================

  /**
   * Broadcast a JSON event to all active WebSocket sessions of a user.
   * No-op (with warning) if SessionManager is not wired or user has no sessions.
   */
  broadcastToUser(userId: UserId, event: Record<string, unknown>): void {
    const payload = JSON.stringify(event);
    const sent = this.sendPayloadToUser(userId, payload);
    if (sent === 0) {
      console.log(`[PubSubService] broadcastToUser(${userId}): no open sessions`);
    } else {
      console.log(`[PubSubService] broadcastToUser(${userId}): ${sent} session(s) delivered`);
    }
  }

  /**
   * Broadcast a JSON event to every member (owner + members[]) of a workspace.
   * No-op (with warning) if WorkspaceService is not wired or workspace not found.
   * The event is serialized once and reused across user fan-out.
   */
  async broadcastToWorkspace(
    workspaceId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (!this.workspaceService) {
      console.warn('[PubSubService] broadcastToWorkspace called but workspaceService not set');
      return;
    }
    const workspace = await this.workspaceService.getWorkspace(workspaceId);
    if (!workspace) {
      console.log(`[PubSubService] broadcastToWorkspace: workspace ${workspaceId} not found`);
      return;
    }
    // Get all user IDs for this workspace: owner + active members from workspace_members collection
    const memberDocs = await this.db.collection('workspace_members')
      .find({ workspaceId, status: { $in: ['active', null] } })
      .project({ userId: 1, _id: 0 })
      .toArray();
    const memberUserIds = memberDocs
      .map((m) => m.userId)
      .filter((id): id is string => !!id);
    const userIds = new Set<string>([workspace.ownerId, ...memberUserIds]);
    const payload = JSON.stringify(event);
    let totalSent = 0;
    for (const userId of userIds) {
      totalSent += this.sendPayloadToUser(userId as UserId, payload);
    }
    console.log(
      `[PubSubService] broadcastToWorkspace(${workspaceId}, users=${userIds.size}): ${totalSent} session(s) delivered`,
    );
  }

  /**
   * Internal helper — sends an already-serialized payload to a user's open sessions.
   * Returns the number of sessions that received the payload.
   */
  private sendPayloadToUser(userId: UserId, payload: string): number {
    if (!this.sessionManager) {
      console.warn('[PubSubService] sendPayloadToUser called but sessionManager not set');
      return 0;
    }
    const sessions = this.sessionManager.getUserSessions(userId);
    let sent = 0;
    for (const session of sessions) {
      if (session.ws.readyState === 1) {
        session.ws.send(payload);
        sent++;
      }
    }
    return sent;
  }

  /**
   * Broadcast a JSON event to EVERY registered WebSocket session, regardless of
   * topic subscriptions or user identity. Used by the admin "refresh all
   * browsers" action (deploy pipeline): the client.refresh signal must reach
   * every connected device, not just sessions subscribed to some topic.
   *
   * Returns the number of sessions the payload was sent to (readyState OPEN
   * only), so the admin surface can report how many clients were reached.
   */
  broadcastToAllSessions(event: Record<string, unknown>): number {
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const session of this.sessionMap.values()) {
      if (session.ws.readyState === 1) {
        session.ws.send(payload);
        sent++;
      }
    }
    console.log(
      `[PubSubService] broadcastToAllSessions: ${sent}/${this.sessionMap.size} session(s) delivered`,
    );
    return sent;
  }

  /**
   * Count of currently registered sessions (all readyStates) — companion to
   * broadcastToAllSessions so callers can report sent vs total.
   */
  getRegisteredSessionCount(): number {
    return this.sessionMap.size;
  }

  // ============================================================================
  // PERSISTENT: CHANNEL-TO-CHANNEL SUBSCRIPTIONS (MongoDB)
  // ============================================================================

  /**
   * Subscribe subscriberChannelId to events from observedChannelId.
   * Idempotent — duplicate subscriptions are silently ignored.
   */
  async subscribeChannel(subscriberChannelId: string, observedChannelId: string): Promise<void> {
    const col = getChannelSubscriptionsCollection(this.db);
    try {
      await col.insertOne({
        subscriberChannelId,
        observedChannelId,
        createdAt: new Date(),
      });
      console.log(
        `[PubSubService] Channel subscription: ${subscriberChannelId} → observes ${observedChannelId}`,
      );
    } catch (err: any) {
      if (err?.code === 11000) {
        // Duplicate key — subscription already exists, ignore
        console.log(
          `[PubSubService] Channel subscription already exists: ${subscriberChannelId} → ${observedChannelId}`,
        );
      } else {
        throw err;
      }
    }
  }

  /**
   * Remove the subscription from subscriberChannelId to observedChannelId.
   */
  async unsubscribeChannel(subscriberChannelId: string, observedChannelId: string): Promise<void> {
    const col = getChannelSubscriptionsCollection(this.db);
    await col.deleteOne({ subscriberChannelId, observedChannelId });
    console.log(
      `[PubSubService] Channel unsubscribed: ${subscriberChannelId} → ${observedChannelId}`,
    );
  }

  /**
   * Return all subscriberChannelIds watching observedChannelId.
   */
  async getObservers(observedChannelId: string): Promise<string[]> {
    const col = getChannelSubscriptionsCollection(this.db);
    const docs = await col.find({ observedChannelId }).toArray();
    return docs.map((d) => d.subscriberChannelId);
  }

  /**
   * Fan out an event to all channels observing observedChannelId.
   * Each observer receives the event via EventHandler.handleScheduledEvent.
   */
  async fanoutToObservers(observedChannelId: string, event: Omit<ScheduledEvent, 'channelId'>): Promise<void> {
    if (!this.eventHandlerFn) {
      console.warn('[PubSubService] fanoutToObservers called but no EventHandler set');
      return;
    }

    const observers = await this.getObservers(observedChannelId);
    if (observers.length === 0) return;

    console.log(
      `[PubSubService] Fanning out "${event.eventType}" from ${observedChannelId} to ${observers.length} observer(s)`,
    );

    await Promise.all(
      observers.map((subscriberChannelId) =>
        this.eventHandlerFn!({ ...event, channelId: subscriberChannelId }).catch((err) => {
          console.error(
            `[PubSubService] Error fanning out to observer ${subscriberChannelId}:`,
            err,
          );
        }),
      ),
    );
  }

  // ============================================================================
  // VIRTUAL LISTENERS (for voice handler — in-memory callbacks)
  // ============================================================================

  /**
   * Register a callback listener for a channel.
   * Used by voice handler to receive agent responses without a real WebSocket session.
   */
  addListener(channelId: string, listener: ChannelMessageListener): void {
    if (!this.channelListeners.has(channelId)) {
      this.channelListeners.set(channelId, new Set());
    }
    this.channelListeners.get(channelId)!.add(listener);
    console.log(`[PubSubService] Listener added for channel ${channelId}`);
  }

  /**
   * Register a global channel listener that is invoked for EVERY channel
   * broadcast, regardless of channelId. Used by the Terminal bridge to route
   * PubSub events to G2 Terminal providers without per-channel registration.
   */
  addGlobalChannelListener(listener: (channelId: string, message: string) => void): void {
    this.globalChannelListeners.add(listener);
    console.log('[PubSubService] Global channel listener added');
  }

  removeGlobalChannelListener(listener: (channelId: string, message: string) => void): void {
    this.globalChannelListeners.delete(listener);
    console.log('[PubSubService] Global channel listener removed');
  }

  /**
   * Remove a previously registered channel listener.
   */
  removeListener(channelId: string, listener: ChannelMessageListener): void {
    this.channelListeners.get(channelId)?.delete(listener);
    if (this.channelListeners.get(channelId)?.size === 0) {
      this.channelListeners.delete(channelId);
    }
    console.log(`[PubSubService] Listener removed for channel ${channelId}`);
  }

  /**
   * Get all virtual listeners for a channel.
   */
  getListeners(channelId: string): ChannelMessageListener[] {
    return Array.from(this.channelListeners.get(channelId) ?? []);
  }
}
