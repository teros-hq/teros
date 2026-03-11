/**
 * Streaming Types for Real-Time Updates
 *
 * Defines the message types for streaming LLM responses and tool execution
 * updates to transport layers (Telegram, WebSocket, etc.) via callbacks.
 */

export type ToolKind = 'read' | 'edit' | 'other';
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Location reference extracted from tool inputs
 * Used to provide clickable file/directory links in transports
 */
export interface ToolLocation {
  path: string;
}

/**
 * Base interface for all stream messages
 */
interface BaseStreamMessage {
  sessionId: string;
  timestamp: number;
}

/**
 * Text chunk from LLM response (character-by-character streaming)
 */
export interface TextChunkMessage extends BaseStreamMessage {
  type: 'text_chunk';
  text: string;
}

/**
 * Text block completed (contains full text of the block)
 * Published when LLM finishes a text content block
 */
export interface TextCompleteMessage extends BaseStreamMessage {
  type: 'text_complete';
  text: string;
  partId: string;
}

/**
 * Tool execution started
 */
export interface ToolStartMessage extends BaseStreamMessage {
  type: 'tool_start';
  toolId: string;
  toolName: string;
  kind: ToolKind;
  locations: ToolLocation[];
  input?: Record<string, any>;
  /** MCP ID for renderer matching (e.g., 'mca.teros.bash') */
  mcaId?: string;
}

/**
 * Tool execution progress update
 */
export interface ToolProgressMessage extends BaseStreamMessage {
  type: 'tool_progress';
  toolId: string;
  status: ToolStatus;
  locations?: ToolLocation[];
}

/**
 * Tool execution completed
 */
export interface ToolCompleteMessage extends BaseStreamMessage {
  type: 'tool_complete';
  toolId: string;
  status: 'completed' | 'failed';
  output?: string;
  error?: string;
  duration?: number;
}

/**
 * Assistant message completed (end of streaming)
 */
export interface MessageCompleteMessage extends BaseStreamMessage {
  type: 'message_complete';
  messageId: string;
  totalTokens?: number;
}

/**
 * Thinking/reasoning content (extended thinking)
 */
export interface ThinkingChunkMessage extends BaseStreamMessage {
  type: 'thinking_chunk';
  text: string;
}

/**
 * Union type of all stream message types
 */
export type StreamMessage =
  | TextChunkMessage
  | TextCompleteMessage
  | ToolStartMessage
  | ToolProgressMessage
  | ToolCompleteMessage
  | MessageCompleteMessage
  | ThinkingChunkMessage;

/**
 * Stream event published via callbacks
 */
export interface StreamEvent {
  channelId: string;
  threadId?: number;
  userId: string;
  message: StreamMessage;
}

/**
 * Configuration for stream publisher
 */
export interface StreamPublisherConfig {
  /**
   * Whether to enable streaming (default: true)
   */
  enabled?: boolean;

  /**
   * Minimum interval between publishes in milliseconds (rate limiting)
   * Default: 100ms (10 updates per second max)
   */
  throttleMs?: number;

  /**
   * Maximum text chunk size before forcing publish
   * Default: 100 characters
   */
  maxChunkSize?: number;
}
