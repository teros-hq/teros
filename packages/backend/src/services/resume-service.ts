/**
 * Resume Service
 *
 * Detects incomplete conversations after a backend restart and
 * triggers system_resume events to continue them.
 *
 * A conversation is considered "incomplete" if:
 * 1. The last message is from the agent with a tool_execution that has status 'running'
 * 2. The last message is from the user and there's no agent response yet
 * 3. The session was active recently (within RESUME_WINDOW_MS) before the restart
 */

import type { Db } from 'mongodb';
import type { EventHandler } from '../handlers/event-handler';
import type { ChannelManager } from './channel-manager';

// Only resume conversations that were active within the last 5 minutes
const RESUME_WINDOW_MS = 5 * 60 * 1000;

// Delay before checking for incomplete conversations (let everything initialize)
const STARTUP_DELAY_MS = 5000;

export interface IncompleteConversation {
  channelId: string;
  agentId: string;
  reason: 'tool_running' | 'pending_approval' | 'no_agent_response' | 'incomplete_response';
  lastMessageId?: string;
  lastMessageTimestamp?: Date;
  lastUserMessage?: string;
}

export class ResumeService {
  private startupTime: number;

  constructor(
    private db: Db,
    private eventHandler: EventHandler,
    private channelManager: ChannelManager,
  ) {
    this.startupTime = Date.now();
  }

  /**
   * Check for incomplete conversations and trigger resume events
   * Should be called after the backend is fully initialized
   */
  async checkAndResumeConversations(): Promise<void> {
    console.log('🔄 ResumeService: Checking for incomplete conversations...');

    try {
      const incompleteConversations = await this.findIncompleteConversations();

      if (incompleteConversations.length === 0) {
        console.log('🔄 ResumeService: No incomplete conversations found');
        return;
      }

      console.log(
        `🔄 ResumeService: Found ${incompleteConversations.length} incomplete conversation(s)`,
      );

      for (const conv of incompleteConversations) {
        await this.triggerResumeEvent(conv);
      }

      console.log('🔄 ResumeService: Resume events triggered');
    } catch (error) {
      console.error('🔄 ResumeService: Error checking for incomplete conversations:', error);
    }
  }

  /**
   * Find conversations that were interrupted by the restart
   */
  private async findIncompleteConversations(): Promise<IncompleteConversation[]> {
    const incomplete: IncompleteConversation[] = [];
    const cutoffTime = new Date(this.startupTime - RESUME_WINDOW_MS);

    // Get recently active channels
    const channelsCollection = this.db.collection('channels');
    const messagesCollection = this.db.collection('channel_messages');

    // Find channels with recent activity
    const recentChannels = await channelsCollection
      .find({
        updatedAt: { $gte: cutoffTime },
      })
      .toArray();

    for (const channel of recentChannels) {
      const channelId = channel.channelId || channel._id.toString();
      const agentId = channel.agentId;

      if (!agentId) continue;

      // Get the last few messages from this channel
      const lastMessages = await messagesCollection
        .find({ channelId })
        .sort({ timestamp: -1 })
        .limit(5)
        .toArray();

      if (lastMessages.length === 0) continue;

      const lastMessage = lastMessages[0];
      const lastMessageTime = new Date(lastMessage.timestamp);

      // Skip if last message is too old
      if (lastMessageTime < cutoffTime) continue;

      // Check for incomplete states
      const incompleteReason = this.detectIncompleteState(lastMessages);

      if (incompleteReason) {
        // Find the last user message for context
        const lastUserMsg = lastMessages.find((m) => m.role === 'user');
        const lastUserText =
          lastUserMsg?.content?.type === 'text'
            ? lastUserMsg.content.text
            : lastUserMsg?.content?.transcription || '';

        incomplete.push({
          channelId,
          agentId,
          reason: incompleteReason,
          lastMessageId: lastMessage.messageId || lastMessage._id?.toString(),
          lastMessageTimestamp: lastMessageTime,
          lastUserMessage: lastUserText?.slice(0, 200), // Truncate for logging
        });
      }
    }

    return incomplete;
  }

  /**
   * Detect if a conversation is in an incomplete state
   */
  private detectIncompleteState(messages: any[]): IncompleteConversation['reason'] | null {
    if (messages.length === 0) return null;

    const lastMessage = messages[0];

    // Case 1: Last message is a tool execution that was running or pending approval
    if (lastMessage.role === 'agent' && lastMessage.content?.type === 'tool_execution') {
      const status = lastMessage.content.status;
      if (status === 'running' || status === 'pending') {
        return 'tool_running';
      }
      // Note: pending_approval is handled differently - the permission manager
      // will restore the permission request when the user subscribes to the channel
    }

    // Case 2: Last message is from user with no agent response
    if (lastMessage.role === 'user') {
      return 'no_agent_response';
    }

    // Case 3: Check if there's a user message after the last complete agent response
    // This handles the case where user sent a message but agent didn't finish responding
    const lastUserIndex = messages.findIndex((m) => m.role === 'user');
    const lastAgentIndex = messages.findIndex((m) => m.role === 'agent');

    if (lastUserIndex !== -1 && lastUserIndex < lastAgentIndex) {
      // User message is more recent than agent's last message
      // Check if the agent message after it looks complete
      const agentMsgAfterUser = messages.find((m, i) => m.role === 'agent' && i < lastUserIndex);
      if (!agentMsgAfterUser) {
        return 'no_agent_response';
      }
    }

    return null;
  }

  /**
   * Trigger a system_resume event for an incomplete conversation
   */
  private async triggerResumeEvent(conv: IncompleteConversation): Promise<void> {
    const reasonMessages: Record<IncompleteConversation['reason'], string> = {
      tool_running: 'A tool was executing when the system restarted',
      pending_approval: 'A tool was waiting for user approval when the system restarted',
      no_agent_response: 'The user sent a message but no response was generated',
      incomplete_response: 'The response was interrupted before completion',
    };

    const message = conv.lastUserMessage
      ? `Last user message: "${conv.lastUserMessage}${conv.lastUserMessage.length >= 200 ? '...' : ''}"`
      : 'Please check the conversation history for context.';

    console.log(
      `🔄 ResumeService: Triggering resume for channel ${conv.channelId} (${conv.reason})`,
    );

    await this.eventHandler.handleScheduledEvent({
      channelId: conv.channelId,
      message,
      eventType: 'system_resume',
      wakeUpAgent: true,
      metadata: {
        source: 'resume-service',
        reason: reasonMessages[conv.reason],
        lastMessageId: conv.lastMessageId,
        interruptedAt: conv.lastMessageTimestamp?.toISOString(),
      },
    });
  }

  /**
   * Start the resume service with a delay
   * This allows time for all services to initialize
   */
  static async startWithDelay(
    db: Db,
    eventHandler: EventHandler,
    channelManager: ChannelManager,
  ): Promise<ResumeService> {
    const service = new ResumeService(db, eventHandler, channelManager);

    // Wait for startup delay then check for incomplete conversations
    setTimeout(async () => {
      await service.checkAndResumeConversations();
    }, STARTUP_DELAY_MS);

    return service;
  }
}
