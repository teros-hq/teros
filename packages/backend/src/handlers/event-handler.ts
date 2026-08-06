/**
 * Event Handler
 * Handles external events like scheduled reminders and recurring tasks
 * Injects messages into channels from external sources
 */

import { generateEventId } from '@teros/core';
import type { Db } from 'mongodb';
import type { ChannelManager } from '../services/channel-manager';
import type { SessionManager } from '../services/session-manager';
import type { PubSubService } from '../services/pubsub-service';
import type { AgentUsageTriggerKind } from '../types/database';

export interface ScheduledEvent {
  channelId: string;
  message: string;
  eventType:
    | 'reminder'
    | 'recurring_task'
    | 'system_resume'
    | 'task_update'
    | 'channel_started'
    | 'channel_finished'
    | 'channel_permission'
    | 'channel_resolved'
    | 'task.moved_to_review'
    | 'task.blocked'
    | 'task.auto_wakes_exhausted'
    | 'task.started'
    | 'task.state_changed'
    | 'task.progress_note_added'
    | 'task.dependency_cancelled';
  wakeUpAgent?: boolean; // If true, trigger agent to respond to the event
  metadata?: {
    source?: string;
    reminderId?: number;
    taskId?: number | string;
    cronExpression?: string;
    // For system_resume events
    reason?: string;
    lastMessageId?: string;
    interruptedAt?: string;
    // For task_update events (legacy board tasks)
    boardTaskId?: string;
    taskTitle?: string;
    running?: boolean;

    agentId?: string;
    agentName?: string;
    agentAvatar?: string;
    // For channel_* observer events (observed channel → observer channel)
    observedChannelId?: string;
    observedChannelName?: string;
    toolName?: string;
    appId?: string;
    permissionRequestId?: string;
    resolution?: 'granted' | 'denied';
    // workerChannelId kept for backwards compat with voice handler
    workerChannelId?: string;
    fromStatus?: string;
    toStatus?: string;
    projectId?: string;
    noteText?: string;
    // For task.dependency_cancelled events
    orphanTaskIds?: string[];
  };
}

// Callback type for triggering agent response
export type AgentWakeUpCallback = (
  channelId: string,
  agentId: string,
  message: string,
  triggerKind?: AgentUsageTriggerKind,
) => Promise<void>;

/**
 * Maps every scheduled/injected event type to the agent-usage triggerKind so the
 * session records its true origin instead of masquerading as `user_message`
 * (TER-650). `undefined` means "keep the caller's default" (→ user_message) and
 * is reserved for events that genuinely replay a user turn.
 *
 * This is a total `Record` over `ScheduledEvent['eventType']`, NOT a switch with
 * a `default`: adding a new event type fails the TypeScript build until it is
 * given an explicit triggerKind here. That makes the "new event silently
 * attributed as user_message" bug (a meaning-change class) impossible by
 * construction rather than caught by review.
 */
const EVENT_TRIGGER_KIND: Record<
  ScheduledEvent['eventType'],
  AgentUsageTriggerKind | undefined
> = {
  // Scheduler-originated wakeups.
  reminder: 'scheduled',
  recurring_task: 'scheduled',
  // Replays the user's interrupted turn → keep the caller's default (user_message).
  system_resume: undefined,
  // Board / channel subscription wakeups — the agent is woken by an event it
  // subscribed to, not by a direct user message.
  task_update: 'event_subscription',
  channel_started: 'event_subscription',
  channel_finished: 'event_subscription',
  channel_permission: 'event_subscription',
  channel_resolved: 'event_subscription',
  'task.moved_to_review': 'event_subscription',
  'task.blocked': 'event_subscription',
  'task.auto_wakes_exhausted': 'event_subscription',
  'task.started': 'event_subscription',
  'task.state_changed': 'event_subscription',
  'task.progress_note_added': 'event_subscription',
  'task.dependency_cancelled': 'event_subscription',
};

export function mapEventTypeToTriggerKind(
  eventType: ScheduledEvent['eventType'],
): AgentUsageTriggerKind | undefined {
  return EVENT_TRIGGER_KIND[eventType];
}

export class EventHandler {
  private agentWakeUpCallback?: AgentWakeUpCallback;
  private pubSubService?: PubSubService;

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
   * Wire in PubSubService so broadcastToChannel delegates to it.
   */
  setPubSubService(pubSubService: PubSubService): void {
    this.pubSubService = pubSubService;
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

      const messageId = generateEventId();
      const timestamp = new Date();
      const description =
        eventType === 'reminder'
          ? `⏰ Reminder: ${message}`
          : eventType === 'system_resume'
            ? `🔄 System Resume: ${message}`
            : eventType === 'task_update'
              ? `📋 Task Update: ${message}`
              : eventType === 'channel_started'
                ? `▶️ Channel Started: ${message}`
                : eventType === 'channel_finished'
                  ? `✅ Channel Finished: ${message}`
                  : eventType === 'channel_permission'
                    ? `🔒 Permission Required: ${message}`
                    : eventType === 'channel_resolved'
                      ? `🔓 Permission Resolved: ${message}`
                      : eventType === 'task.moved_to_review'
                        ? `✅ Task Review: ${message}`
                        : eventType === 'task.blocked'
                          ? `🚫 Task Blocked: ${message}`
                          : eventType === 'task.auto_wakes_exhausted'
                            ? `⚠️ Auto-Wakes Exhausted: ${message}`
                            : eventType === 'task.started'
                              ? `▶️ Task Started: ${message}`
                              : eventType === 'task.state_changed'
                                ? `🔄 Task State Changed: ${message}`
                                : eventType === 'task.progress_note_added'
                                  ? `📝 Progress Note: ${message}`
                                  : `🔄 Scheduled: ${message}`;

      // Create the event message for storage (as a message in the conversation)
      // Note: sender is omitted (not a string!) so the message passes MessageSchema
      // validation on the frontend. The frontend detects system events via
      // role='system' + content.type='event'.
      const eventMessage = {
        messageId,
        channelId,
        role: 'system',
        content: {
          type: 'event' as const,
          eventType,
          eventData: {
            message,
            ...metadata,
          },
          description,
        },
        timestamp: timestamp.toISOString(),
      };

      // Save to messages collection
      const messagesCollection = this.db.collection('channel_messages');
      await messagesCollection.insertOne(eventMessage);

      // Broadcast as a regular message so the frontend renders it in the chat,
      // AND as a system_event so the TerosClient can wake up the agent if needed.
      this.broadcastToChannel(channelId, {
        type: 'message',
        channelId,
        message: eventMessage,
      });

      // Also broadcast the legacy 'event' type so TerosClient can still emit 'system_event'
      // and wake up the agent via agentWakeUpCallback.
      this.broadcastToChannel(channelId, {
        type: 'event',
        channelId,
        event: {
          id: messageId,
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
        this.agentWakeUpCallback(
          channelId,
          channel.agentId,
          agentPrompt,
          mapEventTypeToTriggerKind(eventType),
        ).catch((error) => {
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
    } else if (eventType === 'channel_started') {
      return `[SYSTEM EVENT - CHANNEL STARTED]\n${message}`;
    } else if (eventType === 'channel_finished') {
      return `[SYSTEM EVENT - CHANNEL FINISHED]\n${message}\n\nThe observed channel has finished its turn. Review the result if needed.`;
    } else if (eventType === 'channel_permission') {
      const { observedChannelId, toolName } = metadata ?? {};
      return `[SYSTEM EVENT - PERMISSION REQUIRED]\n${message}\n\nThe observed channel (${observedChannelId}) is waiting for approval to use tool: ${toolName}. Go to that channel to approve or deny.`;
    } else if (eventType === 'channel_resolved') {
      const { resolution, toolName } = metadata ?? {};
      return `[SYSTEM EVENT - PERMISSION RESOLVED]\nThe tool "${toolName}" was ${resolution} in an observed channel.`;
    } else if (eventType === 'task.state_changed') {
      const { taskTitle, fromStatus, toStatus } = metadata ?? {};
      return `[SYSTEM EVENT - BOARD]\nTask "${taskTitle ?? 'unknown'}" changed from ${fromStatus ?? '?'} to ${toStatus ?? '?'}.`;
    } else if (eventType === 'task.moved_to_review') {
      const { taskTitle } = metadata ?? {};
      return `[SYSTEM EVENT - BOARD]\nTask "${taskTitle ?? 'unknown'}" has been moved to review and requires your attention.`;
    } else if (eventType === 'task.started') {
      const { taskTitle } = metadata ?? {};
      return `[SYSTEM EVENT - BOARD]\nAgent started working on task "${taskTitle ?? 'unknown'}".`;
    } else if (eventType === 'task.blocked') {
      const { taskTitle } = metadata ?? {};
      return `[SYSTEM EVENT - BOARD]\nTask "${taskTitle ?? 'unknown'}" is blocked and requires your intervention.`;
    } else if (eventType === 'task.progress_note_added') {
      const { taskTitle, noteText } = metadata ?? {};
      return `[SYSTEM EVENT - BOARD]\nProgress note added to task "${taskTitle ?? 'unknown'}": ${noteText ?? message}`;
    } else if (eventType === 'task.auto_wakes_exhausted') {
      const { taskTitle } = metadata ?? {};
      return `[SYSTEM EVENT - BOARD]\nTask "${taskTitle ?? 'unknown'}" was automatically moved to blocked after 5 auto-wakes without progress.`;
    } else if (eventType === 'task.dependency_cancelled') {
      const { taskTitle, orphanTaskIds } = metadata ?? {};
      const orphanCount = orphanTaskIds?.length ?? 0;
      return `[SYSTEM EVENT - BOARD]\nTask "${taskTitle ?? 'unknown'}" was cancelled. ${orphanCount} dependent task(s) are now orphaned and require your review.`;
    }

    return `[SYSTEM EVENT]\n${message}`;
  }

  /**
   * Broadcast a message to all clients subscribed to a channel
   */
  private broadcastToChannel(channelId: string, message: any): void {
    console.log(`📡 [EventHandler] Broadcasting event to channel ${channelId}`);
    // PubSubService handles both WebSocket sessions and virtual listeners (voice handler)
    this.pubSubService?.broadcastToTopic(`channel:${channelId}`, message);
  }
}
