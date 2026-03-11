/**
 * Session Manager
 * Manages active WebSocket connections and user sessions
 */

import { generateSessionId } from '@teros/core';
import type { UserId } from '@teros/shared';
import type { WebSocket } from 'ws';

export interface Session {
  sessionId: string;
  userId: UserId;
  ws: WebSocket;
  connectedAt: Date;
  lastActivityAt: Date;
  subscribedChannels: Set<string>;
  subscribedBoards: Set<string>;
}

export type ChannelMessageListener = (message: string) => void;

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private userSessions: Map<UserId, Set<string>> = new Map(); // userId -> sessionIds
  private channelListeners: Map<string, Set<ChannelMessageListener>> = new Map(); // channelId -> listeners

  /**
   * Create a new session for authenticated user
   */
  createSession(userId: UserId, ws: WebSocket): Session {
    const sessionId = generateSessionId();

    const session: Session = {
      sessionId,
      userId,
      ws,
      connectedAt: new Date(),
      lastActivityAt: new Date(),
      subscribedChannels: new Set(),
      subscribedBoards: new Set(),
    };

    this.sessions.set(sessionId, session);

    // Track user sessions
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(sessionId);

    console.log(`✅ Session created: ${sessionId} for user ${userId}`);

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get all sessions for a user
   */
  getUserSessions(userId: UserId): Session[] {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return [];

    return Array.from(sessionIds)
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined);
  }

  /**
   * Remove session
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Remove from user sessions
    const userSessionIds = this.userSessions.get(session.userId);
    if (userSessionIds) {
      userSessionIds.delete(sessionId);
      if (userSessionIds.size === 0) {
        this.userSessions.delete(session.userId);
      }
    }

    this.sessions.delete(sessionId);
    console.log(`🗑️  Session removed: ${sessionId}`);
  }

  /**
   * Subscribe session to channel
   */
  subscribeToChannel(sessionId: string, channelId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribedChannels.add(channelId);
      console.log(
        `📺 [SessionManager] Session ${sessionId} subscribed to channel ${channelId} (user: ${session.userId}, total subscriptions: ${session.subscribedChannels.size})`,
      );
    } else {
      console.warn(`⚠️ [SessionManager] Cannot subscribe: session ${sessionId} not found`);
    }
  }

  /**
   * Unsubscribe session from channel
   */
  unsubscribeFromChannel(sessionId: string, channelId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribedChannels.delete(channelId);
    }
  }

  /**
   * Get all sessions subscribed to a channel
   */
  getChannelSubscribers(channelId: string): Session[] {
    const subscribers = Array.from(this.sessions.values()).filter((session) =>
      session.subscribedChannels.has(channelId),
    );

    // Log when broadcasting to help debug subscription issues
    if (subscribers.length === 0) {
      console.warn(
        `⚠️ [SessionManager] No subscribers for channel ${channelId}. Total sessions: ${this.sessions.size}`,
      );
      // Log all sessions and their subscriptions for debugging
      for (const session of this.sessions.values()) {
        console.log(
          `   - Session ${session.sessionId} (user: ${session.userId}): subscribed to [${Array.from(session.subscribedChannels).join(', ')}]`,
        );
      }
    } else {
      console.log(
        `📡 [SessionManager] Broadcasting to ${subscribers.length} subscriber(s) for channel ${channelId}`,
      );
    }

    return subscribers;
  }

  // ==========================================================================
  // BOARD SUBSCRIPTIONS
  // ==========================================================================

  /**
   * Subscribe session to a board (for real-time task updates)
   */
  subscribeToBoard(sessionId: string, boardId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribedBoards.add(boardId);
    }
  }

  /**
   * Unsubscribe session from a board
   */
  unsubscribeFromBoard(sessionId: string, boardId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribedBoards.delete(boardId);
    }
  }

  /**
   * Get all sessions subscribed to a board
   */
  getBoardSubscribers(boardId: string): Session[] {
    return Array.from(this.sessions.values()).filter((session) =>
      session.subscribedBoards.has(boardId),
    );
  }

  // ==========================================================================
  // CHANNEL LISTENERS (virtual subscribers — used by voice handler)
  // ==========================================================================

  /**
   * Register a callback listener for a channel. Called by broadcastToChannel
   * alongside regular WebSocket subscribers. Used by voice handler to receive
   * agent responses without a real WebSocket session.
   */
  addChannelListener(channelId: string, listener: ChannelMessageListener): void {
    if (!this.channelListeners.has(channelId)) {
      this.channelListeners.set(channelId, new Set());
    }
    this.channelListeners.get(channelId)!.add(listener);
    console.log(`🎧 [SessionManager] Channel listener added for ${channelId}`);
  }

  /**
   * Remove a previously registered channel listener.
   */
  removeChannelListener(channelId: string, listener: ChannelMessageListener): void {
    this.channelListeners.get(channelId)?.delete(listener);
    if (this.channelListeners.get(channelId)?.size === 0) {
      this.channelListeners.delete(channelId);
    }
    console.log(`🎧 [SessionManager] Channel listener removed for ${channelId}`);
  }

  /**
   * Get all virtual listeners for a channel.
   */
  getChannelListeners(channelId: string): ChannelMessageListener[] {
    return Array.from(this.channelListeners.get(channelId) ?? []);
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Get total connection count
   */
  getConnectionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get all active sessions
   * Used by ResumeService to notify active conversations on shutdown
   */
  getAllActiveSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get all unique channel IDs with active subscriptions
   */
  getAllActiveChannelIds(): string[] {
    const channelIds = new Set<string>();
    for (const session of this.sessions.values()) {
      for (const channelId of session.subscribedChannels) {
        channelIds.add(channelId);
      }
    }
    return Array.from(channelIds);
  }
}
