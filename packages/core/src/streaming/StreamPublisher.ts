/**
 * StreamPublisher - Publishes streaming updates via callbacks
 *
 * Handles real-time streaming of LLM responses and tool execution to transports.
 * Includes built-in throttling to prevent overwhelming transports.
 */

import { determineToolKind, extractLocations } from './tool-utils';
import type { StreamEvent, StreamMessage, StreamPublisherConfig, ToolLocation } from './types';

const DEFAULT_CONFIG: Required<StreamPublisherConfig> = {
  enabled: true,
  throttleMs: 100, // Max 10 updates per second
  maxChunkSize: 100, // Force publish after 100 chars
};

/**
 * Callback type for stream events
 */
export type StreamCallback = (event: StreamEvent) => void;

/**
 * Usage data from LLM response
 */
export interface LLMUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Callback for final message (when streaming completes)
 */
export type MessageCompleteCallback = (data: {
  channelId: string;
  messageId: string;
  agentId: string;
  text: string;
  timestamp: number;
  usage?: LLMUsageData;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input?: any;
    status: 'completed' | 'failed';
    output?: string;
    error?: string;
    duration?: number;
  }>;
  breakdown?: {
    system: number;
    tools: number;
    examples: number;
    memory: number;
    summary: number;
    conversation: number;
    toolCalls?: number;
    toolResults?: number;
    output?: number;
  };
}) => void;

/**
 * StreamPublisher publishes streaming updates via callbacks
 *
 * Usage:
 * ```typescript
 * const publisher = new StreamPublisher('alice', { throttleMs: 150 })
 * publisher.onStream((event) => {
 *   // Send to WebSocket client
 *   ws.send(JSON.stringify(event))
 * })
 *
 * // In MessageProcessor:
 * publisher.publishTextChunk(sessionId, channelId, userId, threadId, "Hello")
 * publisher.publishTextChunk(sessionId, channelId, userId, threadId, " world")
 * // -> Batched and published: "Hello world"
 * ```
 */
export class StreamPublisher {
  private config: Required<StreamPublisherConfig>;
  private textBuffer: Map<string, { text: string; lastPublish: number }> = new Map();
  private flushTimers: Map<string, NodeJS.Timeout> = new Map();
  private streamCallbacks: StreamCallback[] = [];
  private messageCompleteCallbacks: MessageCompleteCallback[] = [];

  constructor(
    private agentId: string,
    config?: StreamPublisherConfig,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a callback for stream events
   */
  onStream(callback: StreamCallback): void {
    this.streamCallbacks.push(callback);
  }

  /**
   * Register a callback for message complete events
   */
  onMessageComplete(callback: MessageCompleteCallback): void {
    this.messageCompleteCallbacks.push(callback);
  }

  /**
   * Remove all callbacks
   */
  clearCallbacks(): void {
    this.streamCallbacks = [];
    this.messageCompleteCallbacks = [];
  }

  /**
   * Publish text chunk from LLM response
   *
   * Implements intelligent batching:
   * - Buffers text chunks
   * - Publishes when buffer > maxChunkSize
   * - Publishes at most every throttleMs
   * - Auto-flushes after throttleMs * 2 of inactivity
   */
  publishTextChunk(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
    text: string,
  ): void {
    if (!this.config.enabled || !text) {
      return;
    }

    const key = this.getSessionKey(sessionId);
    const now = Date.now();

    // Get or create buffer
    let buffer = this.textBuffer.get(key);
    if (!buffer) {
      buffer = { text: '', lastPublish: now };
      this.textBuffer.set(key, buffer);
    }

    // Append text to buffer
    buffer.text += text;

    // Clear existing flush timer
    const existingTimer = this.flushTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Determine if we should publish now
    const timeSinceLastPublish = now - buffer.lastPublish;
    const shouldPublishNow =
      buffer.text.length >= this.config.maxChunkSize ||
      timeSinceLastPublish >= this.config.throttleMs;

    const shouldForceEdit =
      timeSinceLastPublish >= this.config.throttleMs * 2 && buffer.text.length > 0;

    if (shouldPublishNow || shouldForceEdit) {
      this.flushTextBuffer(sessionId, channelId, userId, threadId);
    } else {
      // Schedule future publish
      const timer = setTimeout(() => {
        this.flushTextBuffer(sessionId, channelId, userId, threadId);
      }, this.config.throttleMs * 2);
      this.flushTimers.set(key, timer);
    }
  }

  /**
   * Flush text buffer immediately (called at end of message)
   */
  flushTextBuffer(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
  ): void {
    const key = this.getSessionKey(sessionId);
    const buffer = this.textBuffer.get(key);

    if (!buffer || !buffer.text) {
      return;
    }

    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'text_chunk',
        sessionId,
        timestamp: Date.now(),
        text: buffer.text,
      },
    };

    this.publish(event);

    // Update last publish time and clear buffer
    buffer.text = '';
    buffer.lastPublish = Date.now();

    // Clear flush timer
    const timer = this.flushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(key);
    }
  }

  /**
   * Publish text block complete (full content of the text block)
   * Called when MessageProcessor finishes a text part
   */
  publishTextComplete(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
    text: string,
    partId: string,
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Flush any pending text chunks first
    this.flushTextBuffer(sessionId, channelId, userId, threadId);

    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'text_complete',
        sessionId,
        timestamp: Date.now(),
        text,
        partId,
      },
    };

    this.publish(event);
  }

  /**
   * Publish tool execution start
   */
  publishToolStart(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
    toolId: string,
    toolName: string,
    input?: Record<string, any>,
    mcaId?: string,
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Flush any pending text before tool execution
    this.flushTextBuffer(sessionId, channelId, userId, threadId);

    const kind = determineToolKind(toolName);
    const locations = input ? extractLocations(toolName, input) : [];

    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'tool_start',
        sessionId,
        timestamp: Date.now(),
        toolId,
        toolName,
        kind,
        locations,
        input,
        mcaId,
      },
    };

    this.publish(event);
  }

  /**
   * Publish tool execution progress
   */
  publishToolProgress(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
    toolId: string,
    status: 'pending' | 'running' | 'completed' | 'failed',
    locations?: ToolLocation[],
  ): void {
    if (!this.config.enabled) {
      return;
    }

    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'tool_progress',
        sessionId,
        timestamp: Date.now(),
        toolId,
        status,
        locations,
      },
    };

    this.publish(event);
  }

  /**
   * Publish tool execution complete
   */
  publishToolComplete(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
    toolId: string,
    status: 'completed' | 'failed',
    output?: string,
    error?: string,
    duration?: number,
  ): void {
    if (!this.config.enabled) {
      return;
    }

    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'tool_complete',
        sessionId,
        timestamp: Date.now(),
        toolId,
        status,
        output,
        error,
        duration,
      },
    };

    this.publish(event);
  }

  /**
   * Publish thinking/reasoning chunk
   */
  publishThinkingChunk(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
    text: string,
  ): void {
    if (!this.config.enabled || !text) {
      return;
    }

    // Flush any pending text before thinking
    this.flushTextBuffer(sessionId, channelId, userId, threadId);

    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'thinking_chunk',
        sessionId,
        timestamp: Date.now(),
        text,
      },
    };

    this.publish(event);
  }

  /**
   * Publish message complete (end of streaming)
   */
  publishMessageComplete(
    sessionId: string,
    channelId: string,
    userId: string,
    threadId: number | undefined,
    messageId: string,
    totalTokens?: number,
    finalText?: string,
    agentId?: string,
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      input?: any;
      status: 'completed' | 'failed';
      output?: string;
      error?: string;
      duration?: number;
    }>,
    usage?: LLMUsageData,
    breakdown?: {
      system: number;
      tools: number;
      examples: number;
      memory: number;
      summary: number;
      conversation: number;
      toolCalls?: number;
      toolResults?: number;
      output?: number;
    },
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Flush any remaining text
    this.flushTextBuffer(sessionId, channelId, userId, threadId);

    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'message_complete',
        sessionId,
        timestamp: Date.now(),
        messageId,
        totalTokens,
      },
    };

    this.publish(event);

    // Also notify message complete callbacks for final message
    // IMPORTANT: Always call callbacks to ensure typing indicator is cleared,
    // even if there's no final text (e.g., tool-only responses)
    const messageData = {
      channelId,
      messageId,
      agentId: agentId || this.agentId,
      text: finalText || '',
      timestamp: Date.now(),
      toolCalls,
      usage,
      breakdown,
    };

    for (const callback of this.messageCompleteCallbacks) {
      try {
        callback(messageData);
      } catch (error) {
        console.error('Error in message complete callback:', error);
      }
    }

    console.log(
      `📤 Message complete: ${messageId}${toolCalls ? ` with ${toolCalls.length} tool calls` : ''}`,
    );

    // Clean up session state
    this.cleanupSession(sessionId);
  }

  /**
   * Clean up resources for a session
   */
  cleanupSession(sessionId: string): void {
    const key = this.getSessionKey(sessionId);

    this.textBuffer.delete(key);

    const timer = this.flushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(key);
    }
  }

  /**
   * Publish event to all registered callbacks
   */
  private publish(event: StreamEvent): void {
    // Transform event to match expected format
    const payload = {
      type: 'message.chunk',
      channelId: event.channelId,
      userId: event.userId,
      threadId: event.threadId,
      data: event.message,
    };

    for (const callback of this.streamCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error('Error in stream callback:', error);
      }
    }

    console.log(`📡 Stream event: ${event.message.type}`);
  }

  /**
   * Generate unique key for session
   */
  private getSessionKey(sessionId: string): string {
    return `stream:${sessionId}`;
  }
}
