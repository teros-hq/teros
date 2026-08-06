import type { HttpToolConfig as ToolConfig, ToolContext } from '@teros/mca-sdk';
import { getWsClient, isWsConnected, type SendMessageResult } from '../lib';

export const sendMessage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Send a message to an existing conversation. The agent will process and respond to the message.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'The ID of the channel to send the message to',
      },
      message: {
        type: 'string',
        description: 'The message text to send',
      },
    },
    required: ['channelId', 'message'],
  },
  handler: async (args, context: ToolContext) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const channelId = args?.channelId as string;
    const message = args?.message as string;

    if (!channelId) {
      throw new Error('channelId is required');
    }
    if (!message || message.trim().length === 0) {
      throw new Error('message is required and cannot be empty');
    }

    // Capture caller identity at call time — safe for parallel invocations.
    // The backend uses senderType + senderId to build the sender field on the
    // destination message, so the receiving agent knows who sent it.
    const callerAgentId = context.execution.agentId;

    const result = await wsClient.queryConversations<SendMessageResult>('send_message', {
      channelId,
      message,
      // Explicit sender identity — no fallback chain, no ambiguity.
      // If agentId is present this is agent-to-agent communication; otherwise
      // the backend will attribute the message to the authenticated user.
      ...(callerAgentId
        ? { senderType: 'agent' as const, senderId: callerAgentId }
        : { senderType: 'user' as const }),
    });

    return {
      success: true,
      messageId: result.messageId,
      channelId: result.channelId,
      timestamp: result.timestamp,
      note: 'Message sent. The agent will process and respond to it.',
    };
  },
};
