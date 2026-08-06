/**
 * Session Manager
 * Manages active WebSocket connections and user sessions
 */

import { generateSessionId } from '@teros/core';
import type { UserId } from '@teros/shared';
import type { WebSocket } from 'ws';
import type { PubSubService } from './pubsub-service';

export interface Session {
  sessionId: string;
  userId: UserId;
  ws: WebSocket;
  connectedAt: Date;
  lastActivityAt: Date;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private userSessions: Map<UserId, Set<string>> = new Map(); // userId -> sessionIds
  private pubSubService?: PubSubService;

  /**
   * Wire in PubSubService so session registration/unregistration delegates to it.
   * Called from index.ts after both services are created.
   */
  setPubSubService(pubSubService: PubSubService): void {
    this.pubSubService = pubSubService;
  }

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
    };

    this.sessions.set(sessionId, session);

    // Track user sessions
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(sessionId);

    // Register with PubSubService so it can look up the WebSocket for broadcasts
    this.pubSubService?.registerSession(sessionId, ws);

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

    // Unregister from PubSubService to clean up all topic subscriptions
    this.pubSubService?.unregisterSession(sessionId);

    console.log(`🗑️  Session removed: ${sessionId}`);
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

}
