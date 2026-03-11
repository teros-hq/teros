/**
 * Event Handler
 * Handles external events like scheduled reminders and recurring tasks
 * Injects messages into channels from external sources
 */

import { generateEventId } from '@teros/core';
import type { Db } from 'mongodb';
import type { ChannelManager } from '../services/channel-manager';
import type { SessionManager } from '../services/session-manager';

export interface ScheduledEvent {
  channelId: string;
  message: string;
  eventType: 'reminder' | 'recurring_task' | 'system_resume' | 'task_update';
  wakeUpAgent?: boolean; // If true, trigger agent to respond to the event
  metadata?: {
    source?: string;
    reminderId?: number;
    taskId?: number;
    cronExpression?: string;
    // For system_resume events
    reason?: string;
    lastMessageId?: string;
    interruptedAt?: string;
    // For task_update events
    boardTaskId?: string;
    workerChannelId?: string; // set when the event comes from a channel (not a board task)
    taskTitle?: string;
    running?: boolean;
    taskStatus?: string;
    agentId?: string;
    agentName?: string;
    agentAvatar?: string;
  };
}

// Callback type for triggering agent response
export type AgentWakeUpCallback = (
  channelId: string,
  agentId: string,
  message: string,
) => Promise<void>;

export class EventHandler {
  private agentWakeUpCallback?: AgentWakeUpCallback;

  constructor(
    private db: Db,
    private sessionManager: SessionManager,
    private channelManager: ChannelManager,
  ) {}

  /**
   * Set the callback for waking up the agent
   * This is called by WebSocketHandler after MessageHandler is created
   */
  setAgentWakeUpCallback(callback: AgentWakeUpCallback): void {
    this.agentWakeUpCallback = callback;
  }

  /**
   * Handle an incoming scheduled event (reminder or recurring task)
   * Injects the message into the channel as a system event
   * Optionally wakes up the agent to respond
   */
  async handleScheduledEvent(event: ScheduledEvent): Promise<{ success: boolean; error?: string }> {
    const { channelId, message, eventType, wakeUpAgent, metadata } = event;

    try {
      // Verify channel exists
      const channel = await this.channelManager.getChannel(channelId);
      if (!channel) {
        return { success: false, error: `Channel ${channelId} not found` };
      }

      const eventId = generateEventId();
      const timestamp = new Date();
      const description =
        eventType === 'reminder'
          ? `⏰ Reminder: ${message}`
          : eventType === 'system_resume'
            ? `🔄 System Resume: ${message}`
            : eventType === 'task_update'
              ? `📋 Task Update: ${message}`
              : `🔄 Scheduled: ${message}`;

      // Create the event message for storage (as a message in the conversation)
      const eventMessage = {
        id: eventId,
        channelId,
        content: {
          type: 'event' as const,
          eventType,
          eventData: {
            message,
            ...metadata,
          },
          description,
        },
        sender: 'system',
        timestamp: timestamp.toISOString(),
      };

      // Save to messages collection
      const messagesCollection = this.db.collection('channel_messages');
      await messagesCollection.insertOne(eventMessage);

      // Broadcast to all connected clients subscribed to this channel
      // Use 'event' type with dedicated schema for real-time events
      this.broadcastToChannel(channelId, {
        type: 'event',
        channelId,
        event: {
          id: eventId,
          eventType,
          message,
          description,
          metadata,
          timestamp: timestamp.toISOString(),
        },
      });

      console.log(`✅ Event injected into channel ${channelId}: ${eventType}`);

      // If wakeUpAgent is true, trigger the agent to respond
      if (wakeUpAgent && this.agentWakeUpCallback) {
        const agentPrompt = this.buildAgentPrompt(eventType, message, metadata);

        console.log(`🔔 Waking up agent for channel ${channelId}`);

        // Fire and forget - don't wait for agent response
        this.agentWakeUpCallback(channelId, channel.agentId, agentPrompt).catch((error) => {
          console.error(`❌ Failed to wake up agent:`, error);
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to handle scheduled event:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Build a prompt for the agent based on the event type
   */
  private buildAgentPrompt(
    eventType: string,
    message: string,
    metadata?: Record<string, any>,
  ): string {
    if (eventType === 'reminder') {
      return `[SYSTEM EVENT - REMINDER]\nThe user has a scheduled reminder that just triggered:\n\n"${message}"\n\nPlease acknowledge this reminder and help the user if needed.`;
    } else if (eventType === 'recurring_task') {
      return `[SYSTEM EVENT - SCHEDULED TASK]\nA recurring scheduled task has triggered:\n\n"${message}"\n\nPlease help the user with this scheduled task.`;
    } else if (eventType === 'system_resume') {
      const reason = metadata?.reason || 'backend restart';
      return `[SYSTEM EVENT - RESUME]\nYour previous response was interrupted due to: ${reason}\n\nPlease continue where you left off. The user's last message and your partial response (if any) are in the conversation history above.\n\nContext: ${message}`;
    } else if (eventType === 'task_update') {
      return `[SYSTEM EVENT - TASK UPDATE]\n${message}\n\nReview this task update and decide if any action is needed. You can check the task details with get-task, send instructions to the worker agent, or inform the user.`;
    }

    return `[SYSTEM EVENT]\n${message}`;
  }

  /**
   * Broadcast a message to all clients subscribed to a channel
   */
  private broadcastToChannel(channelId: string, message: any): void {
    const subscribers = this.sessionManager.getChannelSubscribers(channelId);
    const listeners = this.sessionManager.getChannelListeners(channelId);

    console.log(
      `📡 [EventHandler] Broadcasting event to channel ${channelId}. Subscribers: ${subscribers.length}, listeners: ${listeners.length}`,
    );

    for (const session of subscribers) {
      if (session.ws && session.ws.readyState === 1) {
        // 1 = OPEN
        session.ws.send(JSON.stringify(message));
        console.log(`  ✅ Sent to session ${session.sessionId}`);
      } else {
        console.log(
          `  ⚠️ Skipped session ${session.sessionId} (ws readyState: ${session.ws?.readyState})`,
        );
      }
    }

    // Notify virtual listeners (e.g. voice handler) — same as MessageHandler does
    for (const listener of listeners) {
      try {
        listener(JSON.stringify(message));
      } catch (err) {
        console.error(`  ⚠️ [EventHandler] Error in channel listener for ${channelId}:`, err);
      }
    }
  }
}
