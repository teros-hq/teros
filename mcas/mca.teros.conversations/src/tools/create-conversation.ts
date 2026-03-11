import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { type CreateChannelResult, getWsClient, isWsConnected } from '../lib';

export const createConversation: ToolConfig = {
  description:
    'Create a new conversation with a specific agent. Returns the new channel ID that can be used to send messages.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The ID of the agent to start a conversation with',
      },
      name: {
        type: 'string',
        description: 'Optional name for the conversation',
      },
    },
    required: ['agentId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const agentId = args?.agentId as string;
    const name = args?.name as string | undefined;

    if (!agentId) {
      throw new Error('agentId is required');
    }

    const result = await wsClient.queryConversations<CreateChannelResult>('create_channel', {
      agentId,
      name,
    });

    return {
      success: true,
      channel: result,
    };
  },
};
