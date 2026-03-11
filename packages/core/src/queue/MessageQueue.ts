/**
 * MessageQueue - Event-driven message queue with priority support
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  type EnqueueOptions,
  MessagePriority,
  type MessageQueueConfig,
  MessageStatus,
  type ProcessorFunction,
  type QueuedMessage,
  QueueEvent,
  type QueueStatus,
} from './types';

const DEFAULT_CONFIG: Required<MessageQueueConfig> = {
  concurrency: 1,
  maxQueueSize: 100,
  processingTimeout: 300_000, // 5 minutes
  retryOnError: false,
  maxRetries: 3,
};

export class MessageQueue extends EventEmitter {
  private config: Required<MessageQueueConfig>;
  private queue: QueuedMessage[] = [];
  private processing: boolean = false;
  private paused: boolean = false;
  private currentMessage: QueuedMessage | null = null;
  private processor: ProcessorFunction | null = null;
  private history: QueuedMessage[] = [];
  private todayStats = {
    completed: 0,
    failed: 0,
    date: new Date().toDateString(),
  };

  constructor(config?: MessageQueueConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Enqueue a message for processing
   */
  async enqueue(
    userId: string,
    chatId: number | string, // Can now be channelId (string) or chatId (number)
    threadId: number | undefined,
    messageId: number | undefined,
    text: string,
    options?: EnqueueOptions,
  ): Promise<string> {
    // Determine if this is a channel (string) or chat (number)
    const channelId = typeof chatId === 'string' ? chatId : undefined;
    const chatIdNum = typeof chatId === 'number' ? chatId : undefined;

    const message: QueuedMessage = {
      id: randomUUID(),
      type: 'channel',
      priority: options?.priority ?? MessagePriority.NORMAL,
      timestamp: Date.now(),
      channelId,
      chatId: chatIdNum,
      threadId,
      status: MessageStatus.QUEUED,
      retries: 0,
      userId,
      messageId,
      text,
      transport: options?.transport,
    };

    // Emit received event
    this.emit(QueueEvent.MESSAGE_RECEIVED, message);

    // Check if queue is full
    if (this.queue.length >= this.config.maxQueueSize) {
      this.emit(QueueEvent.QUEUE_FULL);
    }

    // Insert message in priority order (higher priority first)
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (message.priority > this.queue[i].priority) {
        this.queue.splice(i, 0, message);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      this.queue.push(message);
    }

    // Emit queued event
    this.emit(QueueEvent.MESSAGE_QUEUED, message);

    // Start processing if not already processing and not paused
    if (!this.processing && !this.paused && this.processor) {
      this.startProcessing();
    }

    return message.id;
  }

  /**
   * Set the processor function that will handle messages
   */
  setProcessor(processor: ProcessorFunction): void {
    this.processor = processor;

    // Start processing if there are queued messages and not paused
    if (!this.processing && !this.paused && this.queue.length > 0) {
      this.startProcessing();
    }
  }

  /**
   * Pause message processing
   */
  pause(): void {
    this.paused = true;
    this.emit(QueueEvent.PROCESSING_STOPPED);
  }

  /**
   * Resume message processing
   */
  resume(): void {
    this.paused = false;
    this.emit(QueueEvent.PROCESSING_STARTED);

    // Start processing if there are queued messages
    if (!this.processing && this.queue.length > 0 && this.processor) {
      this.startProcessing();
    }
  }

  /**
   * Clear all pending messages from queue
   */
  clear(): QueuedMessage[] {
    const cleared = [...this.queue];
    this.queue = [];
    this.emit(QueueEvent.QUEUE_CLEARED, cleared);
    return cleared;
  }

  /**
   * Emergency stop - clear queue and pause processing
   */
  emergencyStop(): void {
    this.emit(QueueEvent.EMERGENCY_STOP);
    this.clear();
    this.pause();
  }

  /**
   * Cancel a specific message by ID
   */
  cancel(messageId: string): boolean {
    // Don't cancel if it's currently processing
    if (this.currentMessage?.id === messageId) {
      return false;
    }

    const index = this.queue.findIndex((msg) => msg.id === messageId);
    if (index === -1) {
      return false;
    }

    const [cancelled] = this.queue.splice(index, 1);
    cancelled.status = MessageStatus.CANCELLED;
    this.emit(QueueEvent.MESSAGE_CANCELLED, cancelled);

    return true;
  }

  /**
   * Clear the N oldest messages from queue
   */
  clearOldest(count: number): QueuedMessage[] {
    const toRemove = Math.min(count, this.queue.length);
    const cleared = this.queue.splice(this.queue.length - toRemove, toRemove);

    if (cleared.length > 0) {
      this.emit(QueueEvent.QUEUE_CLEARED, cleared);
    }

    return cleared;
  }

  /**
   * Get current queue status
   */
  getStatus(): QueueStatus {
    this.resetStatsIfNewDay();

    return {
      isProcessing: this.processing,
      currentMessage: this.currentMessage,
      pendingCount: this.queue.length,
      completedToday: this.todayStats.completed,
      failedToday: this.todayStats.failed,
      queueSize: this.queue.length,
    };
  }

  /**
   * Get currently processing message
   */
  getCurrentMessage(): QueuedMessage | null {
    return this.currentMessage;
  }

  /**
   * Get all pending messages (sorted by priority)
   */
  getPending(): QueuedMessage[] {
    return [...this.queue];
  }

  /**
   * Get message history (completed and failed)
   */
  getHistory(limit?: number): QueuedMessage[] {
    if (limit) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  /**
   * Start processing messages from the queue
   */
  private async startProcessing(): Promise<void> {
    if (this.processing || this.paused || !this.processor) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && !this.paused) {
      const message = this.queue.shift()!;
      await this.processMessage(message);
    }

    this.processing = false;

    // Emit queue empty event
    if (this.queue.length === 0) {
      this.emit(QueueEvent.QUEUE_EMPTY);
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(message: QueuedMessage): Promise<void> {
    if (!this.processor) {
      return;
    }

    this.currentMessage = message;
    message.status = MessageStatus.PROCESSING;
    this.emit(QueueEvent.MESSAGE_PROCESSING, message);

    try {
      const result = await this.processor(message);

      message.status = MessageStatus.COMPLETED;
      message.result = result;

      this.updateStats('completed');
      this.history.push(message);

      this.emit(QueueEvent.MESSAGE_COMPLETED, message, result);
    } catch (error) {
      message.status = MessageStatus.FAILED;
      message.error = error as Error;

      this.updateStats('failed');
      this.history.push(message);

      this.emit(QueueEvent.MESSAGE_FAILED, message, error);
    } finally {
      this.currentMessage = null;
    }
  }

  /**
   * Update daily statistics
   */
  private updateStats(type: 'completed' | 'failed'): void {
    this.resetStatsIfNewDay();

    if (type === 'completed') {
      this.todayStats.completed++;
    } else {
      this.todayStats.failed++;
    }
  }

  /**
   * Reset stats if it's a new day
   */
  private resetStatsIfNewDay(): void {
    const today = new Date().toDateString();
    if (this.todayStats.date !== today) {
      this.todayStats = {
        completed: 0,
        failed: 0,
        date: today,
      };
    }
  }
}
