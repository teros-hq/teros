/**
 * MongoDB Session Store
 *
 * Stores conversation sessions, messages, and compactions in MongoDB.
 *
 * Collections:
 * - sessions: Session metadata (no embedded messages)
 * - messages: Individual messages with parts
 * - compactions: Conversation summaries when context limit reached
 *
 * To load conversation for LLM:
 * 1. Check for latest compaction
 * 2. If exists, use summary + messages after lastMessageId
 * 3. If not, use all messages
 */

import type { Message, MessagesForLLM, MessageWithParts, Part, Session } from '@teros/core';
import { SessionStore } from '@teros/core';
import type { Collection, Db, ObjectId } from 'mongodb';
import type { Compaction, StoredMessage } from '../types/database';

export class MongoSessionStore extends SessionStore {
  private sessions: Collection<Session>;
  private messages: Collection<StoredMessage>;
  private compactions: Collection<Compaction>;

  constructor(private db: Db) {
    super();
    this.sessions = db.collection<Session>('sessions');
    this.messages = db.collection<StoredMessage>('session_messages');
    this.compactions = db.collection<Compaction>('compactions');

    // Ensure indexes
    this.ensureIndexes().catch((err) => {
      console.error('[MongoSessionStore] Failed to create indexes:', err);
    });
  }

  private async ensureIndexes(): Promise<void> {
    // Messages: query by sessionId, order by _id
    await this.messages.createIndex({ sessionId: 1, _id: 1 });
    // Messages: find by message info.id
    await this.messages.createIndex({ 'info.id': 1 });
    // Compactions: query by sessionId, get latest
    await this.compactions.createIndex({ sessionId: 1, _id: -1 });
    // Sessions: query by userId
    await this.sessions.createIndex({ userId: 1, 'time.updated': -1 });
  }

  // ============================================================================
  // SESSION OPERATIONS
  // ============================================================================

  async getSession(sessionId: string): Promise<Session | undefined> {
    const session = await this.sessions.findOne({ id: sessionId } as any);
    return session || undefined;
  }

  async writeSession(session: Session): Promise<void> {
    // Remove legacy embedded messages if present
    const { messages: _removed, ...sessionWithoutMessages } = session as any;

    await this.sessions.updateOne(
      { id: session.id } as any,
      { $set: sessionWithoutMessages },
      { upsert: true },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Delete session, messages, and compactions
    await Promise.all([
      this.sessions.deleteOne({ id: sessionId } as any),
      this.messages.deleteMany({ sessionId }),
      this.compactions.deleteMany({ sessionId }),
    ]);
  }

  async listSessions(userId: string): Promise<Session[]> {
    return (await this.sessions
      .find({ userId } as any)
      .sort({ 'time.updated': -1 })
      .toArray()) as Session[];
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.sessions.updateOne({ id: sessionId } as any, {
      $set: { 'time.updated': Date.now() },
    });
  }

  // ============================================================================
  // MESSAGE OPERATIONS
  // ============================================================================

  async writeMessage(message: Message): Promise<void> {
    const storedMessage: StoredMessage = {
      sessionId: message.sessionID,
      info: message,
      parts: [],
    };

    await this.messages.insertOne(storedMessage);

    // Touch session
    await this.sessions.updateOne({ id: message.sessionID } as any, {
      $set: { 'time.updated': Date.now() },
    });
  }

  async writePart(part: Part): Promise<void> {
    const messageId = part.messageID;
    const partId = part.id;

    // First, try to update existing part (for streaming updates)
    const updateResult = await this.messages.updateOne(
      {
        'info.id': messageId,
        'parts.id': partId,
      },
      {
        $set: { 'parts.$': part },
      },
    );

    // If no part was updated, it's a new part - push it
    if (updateResult.matchedCount === 0) {
      await this.messages.updateOne({ 'info.id': messageId }, { $push: { parts: part } });
    }

    // Touch session
    await this.sessions.updateOne({ id: part.sessionID } as any, {
      $set: { 'time.updated': Date.now() },
    });
  }

  /**
   * Get all messages for a session (without compaction filtering)
   * Used internally and for migration
   */
  async getAllMessages(sessionId: string): Promise<MessageWithParts[]> {
    const messages = await this.messages.find({ sessionId }).sort({ _id: 1 }).toArray();

    return messages
      .filter((msg) => msg.info && msg.info.role)
      .map((msg) => ({
        info: msg.info,
        parts: msg.parts || [],
      }));
  }

  /**
   * Get messages with compaction awareness
   * This is the main method for loading conversation for LLM
   */
  async getMessagesForLLM(sessionId: string): Promise<MessagesForLLM> {
    // 1. Check for latest compaction
    const lastCompaction = await this.compactions.findOne({ sessionId }, { sort: { _id: -1 } });

    // 2. Build query based on compaction
    const query: any = { sessionId };
    if (lastCompaction) {
      query._id = { $gt: lastCompaction.lastMessageId };
    }

    // 3. Get messages
    const messages = await this.messages.find(query).sort({ _id: 1 }).toArray();

    const messageWithParts = messages
      .filter((msg) => msg.info && msg.info.role)
      .map((msg) => ({
        info: msg.info,
        parts: msg.parts || [],
      }));

    return {
      summary: lastCompaction?.summary,
      messages: messageWithParts,
    };
  }

  /**
   * Get messages with parts - implements SessionStore interface
   * Now uses compaction-aware loading
   */
  async getMessagesWithParts(sessionId: string): Promise<MessageWithParts[]> {
    // For backward compatibility, return all messages after compaction boundary
    const { messages } = await this.getMessagesForLLM(sessionId);
    return messages;
  }

  async listParts(messageId: string): Promise<Part[]> {
    const message = await this.messages.findOne({ 'info.id': messageId });
    return message?.parts || [];
  }

  // ============================================================================
  // COMPACTION OPERATIONS
  // ============================================================================

  /**
   * Get the latest compaction summary for a session
   */
  async getCompactionSummary(sessionId: string): Promise<string | undefined> {
    const lastCompaction = await this.compactions.findOne({ sessionId }, { sort: { _id: -1 } });
    return lastCompaction?.summary;
  }

  /**
   * Create a new compaction record
   * This is append-only - old compactions are preserved
   */
  async createCompaction(
    sessionId: string,
    summary: string,
    lastMessageId: ObjectId,
    stats: {
      messagesCompacted: number;
      tokensBefore: number;
      tokensAfter: number;
    },
  ): Promise<void> {
    const compaction: Compaction = {
      sessionId,
      summary,
      lastMessageId,
      stats,
      createdAt: new Date(),
    };

    await this.compactions.insertOne(compaction);

    // Update session flag
    await this.sessions.updateOne({ id: sessionId } as any, {
      $set: { hasCompaction: true, 'time.updated': Date.now() },
    });

    console.log(`[MongoSessionStore] Created compaction for session ${sessionId}:`, {
      messagesCompacted: stats.messagesCompacted,
      tokensBefore: stats.tokensBefore,
      tokensAfter: stats.tokensAfter,
    });
  }

  /**
   * Get the MongoDB ObjectId of the last message in a session
   * Used when creating compaction to mark the boundary
   */
  async getLastMessageObjectId(sessionId: string): Promise<ObjectId | undefined> {
    const lastMessage = await this.messages.findOne(
      { sessionId },
      { sort: { _id: -1 }, projection: { _id: 1 } },
    );
    return lastMessage?._id;
  }

  /**
   * Override base class method - no longer stores in session
   */
  async updateCompactionSummary(
    sessionId: string,
    summary: string,
    compactedMessageIds: string[],
  ): Promise<void> {
    // Get the last message ObjectId as boundary
    const lastMessageId = await this.getLastMessageObjectId(sessionId);
    if (!lastMessageId) {
      console.warn(
        `[MongoSessionStore] No messages found for session ${sessionId}, skipping compaction`,
      );
      return;
    }

    // Create compaction record
    await this.createCompaction(sessionId, summary, lastMessageId, {
      messagesCompacted: compactedMessageIds.length,
      tokensBefore: 0, // Will be updated by caller if needed
      tokensAfter: 0,
    });
  }

  // ============================================================================
  // MIGRATION HELPERS
  // ============================================================================

  /**
   * Migrate a session from embedded messages to separate collection
   * Returns true if migration was performed
   */
  async migrateSession(sessionId: string): Promise<boolean> {
    const session = (await this.sessions.findOne({ id: sessionId } as any)) as any;
    if (!session) return false;

    const embeddedMessages = session.messages || [];
    if (embeddedMessages.length === 0) return false;

    // Check if already migrated (messages exist in collection)
    const existingCount = await this.messages.countDocuments({ sessionId });
    if (existingCount > 0) {
      console.log(`[MongoSessionStore] Session ${sessionId} already migrated, skipping`);
      return false;
    }

    // Insert messages into collection
    const storedMessages: StoredMessage[] = embeddedMessages
      .filter((msg: any) => msg && msg.info && msg.info.role)
      .map((msg: any) => ({
        sessionId,
        info: msg.info,
        parts: msg.parts || [],
      }));

    if (storedMessages.length > 0) {
      await this.messages.insertMany(storedMessages);
    }

    // Migrate compaction if exists
    if (session.compaction?.summary) {
      const lastMessageId = await this.getLastMessageObjectId(sessionId);
      if (lastMessageId) {
        await this.createCompaction(sessionId, session.compaction.summary, lastMessageId, {
          messagesCompacted: session.compaction.compactedMessageIds?.length || 0,
          tokensBefore: 0,
          tokensAfter: 0,
        });
      }
    }

    // Remove embedded messages from session
    await this.sessions.updateOne({ id: sessionId } as any, {
      $unset: { messages: '', compaction: '' },
    });

    console.log(
      `[MongoSessionStore] Migrated session ${sessionId}: ${storedMessages.length} messages`,
    );
    return true;
  }

  /**
   * Migrate all sessions with embedded messages
   */
  async migrateAllSessions(): Promise<{ migrated: number; skipped: number }> {
    const sessions = await this.sessions.find({ messages: { $exists: true } } as any).toArray();

    let migrated = 0;
    let skipped = 0;

    for (const session of sessions) {
      const wasMigrated = await this.migrateSession(session.id);
      if (wasMigrated) {
        migrated++;
      } else {
        skipped++;
      }
    }

    return { migrated, skipped };
  }
}
