/**
 * In-Memory Session Store
 *
 * Simple in-memory implementation of SessionStore for testing and minimal deployments.
 * Data is lost on restart - use SqliteSessionStore for persistence.
 */

import type {
  AssistantMessage,
  Message,
  MessageWithParts,
  Part,
  Session,
  UserMessage,
} from './types';

export class InMemorySessionStore {
  private sessions: Map<string, Session> = new Map();
  private messages: Map<string, Message> = new Map();
  private parts: Map<string, Part> = new Map();

  // ==========================================================================
  // SESSION OPERATIONS
  // ==========================================================================

  async writeSession(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async readSession(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) || null;
  }

  // Alias for compatibility with SessionStore interface
  async getSession(sessionId: string): Promise<Session | null> {
    return this.readSession(sessionId);
  }

  // Touch session (update timestamp)
  async touchSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.time.updated = Date.now();
      this.sessions.set(sessionId, session);
    }
  }

  // List sessions for a user
  async listSessions(userId: string): Promise<Session[]> {
    return Array.from(this.sessions.values())
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.time.updated - a.time.updated);
  }

  async getAllSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values());
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    // Also delete associated messages and parts
    for (const [msgId, msg] of this.messages.entries()) {
      if (msg.sessionID === sessionId) {
        this.messages.delete(msgId);
      }
    }
    for (const [partId, part] of this.parts.entries()) {
      const msg = this.messages.get(part.messageID);
      if (msg?.sessionID === sessionId) {
        this.parts.delete(partId);
      }
    }
  }

  // ==========================================================================
  // MESSAGE OPERATIONS
  // ==========================================================================

  async writeMessage(message: Message): Promise<void> {
    this.messages.set(message.id, { ...message });
  }

  async readMessage(messageId: string): Promise<Message | null> {
    return this.messages.get(messageId) || null;
  }

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter((msg) => msg.sessionID === sessionId)
      .sort((a, b) => a.time.created - b.time.created);
  }

  async getSessionMessagesWithParts(sessionId: string): Promise<MessageWithParts[]> {
    const messages = await this.getSessionMessages(sessionId);
    return Promise.all(
      messages.map(async (msg) => ({
        info: msg,
        parts: await this.getMessageParts(msg.id),
      })),
    );
  }

  // Alias for compatibility with SessionStore interface
  async getMessagesWithParts(sessionId: string): Promise<MessageWithParts[]> {
    return this.getSessionMessagesWithParts(sessionId);
  }

  // ==========================================================================
  // PART OPERATIONS
  // ==========================================================================

  async writePart(part: Part): Promise<void> {
    this.parts.set(part.id, { ...part });
  }

  async readPart(partId: string): Promise<Part | null> {
    return this.parts.get(partId) || null;
  }

  async getMessageParts(messageId: string): Promise<Part[]> {
    return Array.from(this.parts.values()).filter((part) => part.messageID === messageId);
    // Parts don't have an index field, return in insertion order
  }

  // Alias for compatibility with SessionStore interface
  async listParts(messageId: string): Promise<Part[]> {
    return this.getMessageParts(messageId);
  }

  async updatePart(partId: string, updates: any): Promise<void> {
    const part = this.parts.get(partId);
    if (part) {
      this.parts.set(partId, { ...part, ...updates } as Part);
    }
  }

  // ==========================================================================
  // UTILITY OPERATIONS
  // ==========================================================================

  /**
   * Get latest message in a session
   */
  async getLatestMessage(sessionId: string): Promise<Message | null> {
    const messages = await this.getSessionMessages(sessionId);
    return messages.length > 0 ? messages[messages.length - 1] : null;
  }

  /**
   * Get latest user message in a session
   */
  async getLatestUserMessage(sessionId: string): Promise<UserMessage | null> {
    const messages = await this.getSessionMessages(sessionId);
    const userMessages = messages.filter((msg) => msg.role === 'user') as UserMessage[];
    return userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
  }

  /**
   * Get latest assistant message in a session
   */
  async getLatestAssistantMessage(sessionId: string): Promise<AssistantMessage | null> {
    const messages = await this.getSessionMessages(sessionId);
    const assistantMessages = messages.filter(
      (msg) => msg.role === 'assistant',
    ) as AssistantMessage[];
    return assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.sessions.clear();
    this.messages.clear();
    this.parts.clear();
  }

  /**
   * Close the store (no-op for in-memory)
   */
  close(): void {
    // Nothing to close for in-memory store
  }

  /**
   * Get statistics
   */
  getStats(): { sessions: number; messages: number; parts: number } {
    return {
      sessions: this.sessions.size,
      messages: this.messages.size,
      parts: this.parts.size,
    };
  }

  /**
   * Clean up old sessions (older than maxAgeMs)
   * Prevents memory leaks by removing stale data
   */
  async cleanupOldSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    const sessionsToDelete: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const age = now - session.time.updated;
      if (age > maxAgeMs) {
        sessionsToDelete.push(sessionId);
      }
    }

    // Delete old sessions
    for (const sessionId of sessionsToDelete) {
      await this.deleteSession(sessionId);
    }

    return sessionsToDelete.length;
  }
}
