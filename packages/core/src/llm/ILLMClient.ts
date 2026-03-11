/**
 * LLM Client Interface - Provider-agnostic streaming interface
 *
 * This interface defines a generic contract for LLM providers.
 * All providers (Anthropic, OpenAI, the previous implementation, etc.) implement this.
 *
 * Design:
 * - Accepts the previous implementation's MessageWithParts[] format
 * - Streams responses via callbacks
 * - Returns generic stop reasons
 * - Provider adapters handle format conversion
 */

import type { MessageWithParts } from '../session/types';

/**
 * Tool definition (generic format, adapters convert to provider-specific)
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

/**
 * Tool result to send back to LLM
 */
export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/**
 * Generic LLM response
 */
export interface LLMResponse {
  stopReason: 'end_turn' | 'tool_calls' | 'max_tokens' | 'error';
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Tokens written to cache (Anthropic prompt caching) */
    cacheCreationInputTokens?: number;
    /** Tokens read from cache (Anthropic prompt caching) */
    cacheReadInputTokens?: number;
  };
  metadata?: Record<string, any>;
}

/**
 * Streaming callbacks for real-time updates
 */
export interface StreamingCallbacks {
  /**
   * Called when text content is streamed
   */
  onText?: (chunk: string) => void | Promise<void>;

  /**
   * Called when a text block is completed
   */
  onTextEnd?: () => void | Promise<void>;

  /**
   * Called when a tool call is requested
   */
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;

  /**
   * Called when thinking/reasoning content is streamed (Claude extended thinking)
   */
  onThinking?: (chunk: string) => void | Promise<void>;
}

/**
 * Options for streaming messages
 */
export interface StreamMessageOptions {
  /** Message history in the previous implementation format */
  messages: MessageWithParts[];

  /** Available tools (optional) */
  tools?: ToolDefinition[];

  /** System prompt override (optional) */
  systemPrompt?: string;

  /** Model configuration (optional) */
  model?: string;
  temperature?: number;
  maxTokens?: number;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;

  /** Streaming callbacks */
  callbacks?: StreamingCallbacks;

  /**
   * Index in messages array where cache breakpoint should be placed.
   * Content up to and including this index will be marked for caching.
   * Used by Anthropic adapter for prompt caching optimization.
   */
  cacheBreakpointIndex?: number;

  /** Context metadata for usage tracking (optional) */
  userId?: string;
  workspaceId?: string;
  agentId?: string;
  channelId?: string;
}

/**
 * LLM Client Interface
 *
 * All LLM providers must implement this interface.
 * Adapters handle conversion between the previous implementation format and provider-specific formats.
 */
export interface ILLMClient {
  /**
   * Stream a message to the LLM and get a response
   *
   * This is the main method used by ConversationManager.
   * It accepts the previous implementation's MessageWithParts[] format and returns a generic response.
   *
   * The adapter is responsible for:
   * 1. Converting MessageWithParts[] to provider's format
   * 2. Streaming the response and calling callbacks
   * 3. Converting provider's response to LLMResponse
   */
  streamMessage(options: StreamMessageOptions): Promise<LLMResponse>;

  /**
   * Get provider information
   */
  getProviderInfo(): {
    name: string;
    model: string;
    [key: string]: any;
  };
}
