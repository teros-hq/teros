import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected, SENDER_AGENT_ID, type SendMessageResult } from '../lib';

export const sendMessage: ToolConfig = {
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
  handler: async (args) => {
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

    const result = await wsClient.queryConversations<SendMessageResult>('send_message', {
      channelId,
      message,
      // Include sender agent ID if this is agent-to-agent communication
      ...(SENDER_AGENT_ID && { senderAgentId: SENDER_AGENT_ID }),
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
