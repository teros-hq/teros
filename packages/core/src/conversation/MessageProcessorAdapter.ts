/**
 * MessageProcessorAdapter - Compatibility layer
 *
 * Adapts the new ConversationManager to the old MessageProcessor interface
 * that IriaCore expects. This allows Phase 2-3 changes to work with existing code.
 */

import type { ILLMClient } from '../llm/ILLMClient';
import { log } from '../logger';
import { SessionLockManager } from '../session/SessionLockManager';
import type { SessionStore } from '../session/SessionStore';
import type { MessageCompleteCallback, StreamCallback } from '../streaming';
import type { MCPToolExecutor } from '../tools/MCPToolExecutor';
import { ConversationManager } from './ConversationManager';

export interface MessageContext {
  userId: string;
  channelId: string;
  threadId?: number;
  messageId: number;
  text: string;
  timestamp: number;
  transport?: string; // Transport type: 'telegram', 'websocket', 'api', 'channel', etc.
}

export interface ProcessMessageResult {
  text: string;
  streamingUsed: boolean;
}

/**
 * Adapter that wraps ConversationManager to provide the old interface
 */
export class MessageProcessorAdapter {
  private conversationManager: ConversationManager;
  private sessionStore: SessionStore;
  private userId: string;
  private systemPrompt?: string;

  constructor(config: {
    llmClient: ILLMClient;
    sessionStore: SessionStore;
    memoryEnabled?: boolean;
    toolExecutor?: MCPToolExecutor;
    maxSteps?: number;
    systemPrompt?: string;
    agentId?: string;
    enableStreaming?: boolean;
    onStream?: StreamCallback;
    onMessageComplete?: MessageCompleteCallback;
  }) {
    this.sessionStore = config.sessionStore;
    this.systemPrompt = config.systemPrompt;

    // Create ConversationManager with the new architecture
    const lockManager = new SessionLockManager();
    this.conversationManager = new ConversationManager(
      config.sessionStore, // sessionStore
      lockManager, // lockManager
      config.llmClient, // llmClient
      config.agentId || 'berta', // agentId (default: 'berta')
      config.toolExecutor, // toolExecutor (optional)
      {
        // config
        maxSteps: config.maxSteps,
        enableStreaming: config.enableStreaming ?? true, // enabled by default
        onStream: config.onStream,
        onMessageComplete: config.onMessageComplete,
      },
    );

    // Default userId (will be overridden per message)
    this.userId = 'unknown';
  }

  /**
   * Get the session store (for commands and other access)
   */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  /**
   * Get the conversation manager (for interruption requests)
   */
  getConversationManager(): ConversationManager {
    return this.conversationManager;
  }

  /**
   * Process a message (old interface)
   * Converts to new ConversationManager.prompt() call
   */
  async processMessage(context: MessageContext): Promise<ProcessMessageResult> {
    // DEBUG: Log context to detect undefined userId
    console.log('🔍 MessageProcessorAdapter.processMessage called with:', {
      hasUserId: !!context.userId,
      userIdValue: context.userId,
      channelId: context.channelId,
      threadId: context.threadId,
    });

    // Generate session ID from userId, transport, channelId and optional threadId
    const transport = context.transport || 'channel'; // Default to channel for new architecture
    const sessionID = this.generateSessionID(
      context.userId,
      context.channelId,
      context.threadId,
      transport,
    );

    try {
      // Call the new ConversationManager
      const result = await this.conversationManager.prompt({
        sessionID,
        userId: context.userId,
        channelId: context.channelId,
        threadId: context.threadId,
        parts: [
          {
            type: 'text',
            text: context.text,
          },
        ],
        systemPrompt: this.systemPrompt,
      });

      // Extract text from response parts
      let responseText = '';
      for (const part of result.parts) {
        if (part.type === 'text') {
          responseText += part.text;
        }
      }

      return {
        text: responseText || 'No response generated',
        streamingUsed: result.streamingUsed || false,
      };
    } catch (error: any) {
      // Re-throw the error (it's already logged in ConversationManager)
      log.debug('MessageProcessorAdapter', 'Error bubbling up from ConversationManager', {
        sessionID,
        userId: context.userId,
      });
      throw error;
    }
  }

  /**
   * Generate session ID from userId, channelId and threadId
   * Format: session_{userId}_{transport}_{channelId} or session_{userId}_{transport}_{channelId}_thread_{threadId}
   *
   * Including userId and transport ensures sessions are isolated even when multiple users
   * use the same channelId (e.g., tests vs production, different transports)
   */
  private generateSessionID(
    userId: string,
    channelId: string,
    threadId?: number,
    transport: string = 'channel',
  ): string {
    if (threadId) {
      return `session_${userId}_${transport}_${channelId}_thread_${threadId}`;
    }
    return `session_${userId}_${transport}_${channelId}`;
  }

  /**
   * Abort a session (for compatibility)
   */
  async abortSession(userId: string, channelId: string, threadId?: number): Promise<void> {
    const sessionID = this.generateSessionID(userId, channelId, threadId);
    await this.conversationManager.abort(sessionID);
  }

  /**
   * Get queue size for a session (for compatibility)
   */
  getQueueSize(userId: string, channelId: string, threadId?: number): number {
    const sessionID = this.generateSessionID(userId, channelId, threadId);
    return this.conversationManager.getQueueSize(sessionID);
  }

  /**
   * Reset a session (for compatibility with /new command)
   */
  async resetSession(userId: string, channelId: string, threadId?: number): Promise<void> {
    const sessionID = this.generateSessionID(userId, channelId, threadId);

    // Delete the session from the database
    await this.sessionStore.deleteSession(sessionID);

    log.info('MessageProcessorAdapter', 'Session reset', {
      sessionID,
      userId,
      channelId,
      threadId,
    });
  }
}
