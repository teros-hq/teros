/**
 * Session Store - Abstract interface
 *
 * Implementations should extend this to provide session storage
 */

import type { Message, MessageWithParts, Part, Session } from './types';

/**
 * Result of loading messages for LLM consumption
 */
export interface MessagesForLLM {
  /** Summary from last compaction (if any) */
  summary?: string;
  /** Messages to send to LLM (after compaction boundary) */
  messages: MessageWithParts[];
}

export abstract class SessionStore {
  // Basic session operations
  abstract getSession(sessionId: string): Promise<Session | undefined>;
  abstract writeSession(session: Session): Promise<void>;
  abstract deleteSession(sessionId: string): Promise<void>;
  abstract listSessions(userId: string): Promise<Session[]>;

  // Session activity
  abstract touchSession(sessionId: string): Promise<void>;

  // Message operations (matching berta-teros signatures)
  abstract writeMessage(message: Message): Promise<void>;
  abstract getMessagesWithParts(sessionId: string): Promise<MessageWithParts[]>;

  // Part operations (for tool use/results) (matching berta-teros signatures)
  abstract writePart(part: Part): Promise<void>;
  abstract listParts(messageId: string): Promise<Part[]>;

  // ============================================================================
  // COMPACTION OPERATIONS
  // ============================================================================

  /**
   * Get messages with compaction awareness - main method for LLM consumption
   *
   * Returns:
   * - summary: from last compaction (if any)
   * - messages: only messages AFTER the compaction boundary
   *
   * Default implementation uses legacy embedded compaction.
   * MongoSessionStore overrides this to use separate collections.
   */
  async getMessagesForLLM(sessionId: string): Promise<MessagesForLLM> {
    const session = await this.getSession(sessionId);
    const summary = session?.compaction?.summary;
    const messages = await this.getMessagesWithParts(sessionId);

    return { summary, messages };
  }

  /**
   * Update the compaction summary for a session
   * @param sessionId - Session to update
   * @param summary - The compacted conversation summary
   * @param compactedMessageIds - IDs of messages that were compacted
   */
  async updateCompactionSummary(
    sessionId: string,
    summary: string,
    compactedMessageIds: string[],
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const history = session.compaction?.history || [];

    session.compaction = {
      summary,
      compactedMessageIds,
      lastCompactedAt: Date.now(),
      history: [
        ...history,
        {
          timestamp: Date.now(),
          messagesCompacted: compactedMessageIds.length,
          tokensBefore: 0, // Will be filled by caller
          tokensAfter: 0,
        },
      ].slice(-10), // Keep last 10 compaction events
    };

    await this.writeSession(session);
  }

  /**
   * Get the compaction summary for a session
   * @deprecated Use getMessagesForLLM() instead
   */
  async getCompactionSummary(sessionId: string): Promise<string | undefined> {
    const { summary } = await this.getMessagesForLLM(sessionId);
    return summary;
  }
}
