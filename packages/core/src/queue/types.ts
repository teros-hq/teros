/**
 * Message Queue Types
 */

export enum QueueEvent {
  // Lifecycle
  MESSAGE_RECEIVED = 'message:received',
  MESSAGE_QUEUED = 'message:queued',
  MESSAGE_PROCESSING = 'message:processing',
  MESSAGE_COMPLETED = 'message:completed',
  MESSAGE_FAILED = 'message:failed',
  MESSAGE_CANCELLED = 'message:cancelled',

  // Queue state
  QUEUE_EMPTY = 'queue:empty',
  QUEUE_FULL = 'queue:full',
  QUEUE_CLEARED = 'queue:cleared',

  // Control
  PROCESSING_STARTED = 'processing:started',
  PROCESSING_STOPPED = 'processing:stopped',
  EMERGENCY_STOP = 'emergency:stop',
}

export enum MessagePriority {
  NORMAL = 0,
  HIGH = 5,
  EMERGENCY = 10,
}

export enum MessageStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Base message interface - common fields for all message types
 */
export interface BaseQueuedMessage {
  id: string;
  priority: MessagePriority;
  timestamp: number;
  channelId?: string; // New: channel-based architecture
  chatId?: number; // Legacy: Telegram chat ID
  threadId?: number;

  // State
  status: MessageStatus;
  retries: number;
  error?: Error;

  // Result
  result?: any;
}

/**
 * Channel message (from WebSocket or other transports)
 */
export interface ChannelMessage extends BaseQueuedMessage {
  type: 'channel';
  userId: string;
  messageId?: number;
  text: string;
  transport?: string;
}

/**
 * Discriminated union of all message types
 */
export type QueuedMessage = ChannelMessage;

export type MessageType = QueuedMessage['type'];

export interface EnqueueOptions {
  priority?: MessagePriority;
  type?: MessageType;

  // Channel-specific options
  userId?: string;
  messageId?: number;
  text?: string;
  transport?: string;
}

export interface MessageQueueConfig {
  concurrency?: number;
  maxQueueSize?: number;
  processingTimeout?: number;
  retryOnError?: boolean;
  maxRetries?: number;
}

export interface QueueStatus {
  isProcessing: boolean;
  currentMessage: QueuedMessage | null;
  pendingCount: number;
  completedToday: number;
  failedToday: number;
  queueSize: number;
}

export type ProcessorFunction = (message: QueuedMessage) => Promise<any>;
