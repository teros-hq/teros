/**
 * StreamPublisher - Publishes streaming updates via callbacks
 *
 * Handles real-time streaming of LLM responses and tool execution to transports.
 * Includes built-in throttling to prevent overwhelming transports.
 */

import { determineToolKind, extractLocations } from './tool-utils';
import type {
  AgentPhase,
  QueueState,
  StreamEvent,
  StreamMessage,
  StreamPublisherConfig,
  ToolLocation,
} from './types';

const DEFAULT_CONFIG: Required<StreamPublisherConfig> = {
  enabled: true,
  throttleMs: 40,
  maxChunkSize: 30,
};

/**
 * Callback type for stream events.
 * May return a Promise — StreamPublisher tracks these so callers can await
 * all in-flight handlers via flushCallbacks().
 */
export type StreamCallback = (event: StreamEvent) => void | Promise<void>;

/**
 * Usage data from LLM response
 */
export interface LLMUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Reasoning tokens reported by the provider usage (Together; absent on Fireworks). TER-615. */
  reasoningTokens?: number;
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
  /**
   * Provider metadata accumulated across the LLM steps of this turn
   * (typically the last response's metadata: `{ id, model, ... }`).
   *
   * Fix of a pre-existing bug: previously the metadata was not propagated to
   * the callback, so consumers (agent-loop.ts:220-233) saw `data.metadata`
   * undefined and silently fell back to `agentConfig.llm.provider`.
   */
  responseMetadata?: Record<string, any>;
  /**
   * Opaque correlation ID for the agent usage instrumentation subsystem.
   * When present, `handleMessageComplete` propagates it as the FK
   * `sessionUsageId` on the `llm_usage` row and as part of the
   * `session.delta` event emitted to the UsageEventBuffer.
   */
  sessionUsageId?: string;
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
  /** Tracks in-flight async callback promises for flushCallbacks() */
  private pendingCallbackPromises: Array<Promise<void>> = [];

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
   * Await all in-flight async stream callbacks.
   *
   * Call this after publishToolStart() inside handleToolCall() so that
   * the tool_start handler (which saves the tool message to DB and broadcasts
   * the initial message + tool_call_start events) fully completes before
   * executeTool() is called.  Without this, tool_status_update(pending_permission)
   * can race ahead of the initial message events for Gemini (where tool calls
   * fire after the stream ends rather than during it).
   */
  async flushCallbacks(): Promise<void> {
    if (this.pendingCallbackPromises.length === 0) return;
    const pending = this.pendingCallbackPromises;
    this.pendingCallbackPromises = [];
    await Promise.all(pending);
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

    this.publishAgentPhase(channelId, userId, 'streaming_text', threadId);

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
    this.publishAgentPhase(channelId, userId, 'executing_tool', threadId);

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
    attachments?: Array<{ url: string; mime: string; filename?: string }>,
  ): void {
    if (!this.config.enabled) {
      return;
    }
    this.publishAgentPhase(channelId, userId, 'thinking', threadId);

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
        attachments,
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
    responseMetadata?: Record<string, any>,
    sessionUsageId?: string,
  ): void {
    if (!this.config.enabled) {
      return;
    }
    this.publishAgentPhase(channelId, userId, 'idle', threadId);

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
      responseMetadata,
      sessionUsageId,
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
    this.cleanupSession(sessionId, channelId);
  }

  publishQueueStateChange(
    channelId: string,
    userId: string,
    messageId: string,
    state: QueueState,
    threadId?: number,
    assistantId?: string,
  ): void {
    if (!this.config.enabled) return;
    const baseMessage = {
      sessionId: channelId,
      timestamp: Date.now(),
      messageId,
    };
    const message: StreamMessage =
      state === 'done'
        ? { ...baseMessage, type: 'queue_state', state: 'done', ...(assistantId ? { assistantId } : {}) }
        : { ...baseMessage, type: 'queue_state', state };
    this.publish({ channelId, threadId, userId, message });
  }

  /** Per-channel dedup so a streaming burst doesn't flood the WS. */
  private currentAgentPhase = new Map<string, AgentPhase>();

  getAgentPhase(channelId: string): AgentPhase | undefined {
    return this.currentAgentPhase.get(channelId);
  }

  publishAgentPhase(
    channelId: string,
    userId: string,
    phase: AgentPhase,
    threadId?: number,
  ): void {
    if (!this.config.enabled) return;
    const prev = this.currentAgentPhase.get(channelId);
    if (prev === phase) return;
    this.currentAgentPhase.set(channelId, phase);
    const event: StreamEvent = {
      channelId,
      threadId,
      userId,
      message: {
        type: 'agent_phase',
        sessionId: channelId,
        timestamp: Date.now(),
        phase,
      },
    };
    this.publish(event);
  }

  /**
   * Clean up resources for a session
   */
  cleanupSession(sessionId: string, channelId?: string): void {
    const key = this.getSessionKey(sessionId);

    this.textBuffer.delete(key);

    const timer = this.flushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(key);
    }
    // `currentAgentPhase` is keyed by channelId — pass it explicitly when
    // available; fall back to sessionId for legacy callers where the two
    // coincide.
    this.currentAgentPhase.delete(channelId ?? sessionId);
  }

  /**
   * Publish event to all registered callbacks.
   * If a callback returns a Promise, it is collected so flushCallbacks() can await it.
   */
  private publish(event: StreamEvent): void {
    for (const callback of this.streamCallbacks) {
      try {
        const result = callback(event);
        if (result instanceof Promise) {
          this.pendingCallbackPromises.push(
            result.catch((error) => {
              console.error('Error in async stream callback:', error);
            }),
          );
        }
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
