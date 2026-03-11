import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const linkConversation: ToolConfig = {
  description: 'Link an existing conversation to a task. Replaces any previously linked conversation.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID',
      },
      channelId: {
        type: 'string',
        description: 'The conversation channel ID to link',
      },
    },
    required: ['taskId', 'channelId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    const channelId = args?.channelId as string;
    if (!taskId || !channelId) {
      throw new Error('taskId and channelId are required');
    }

    const result = await wsClient.queryConversations<any>('link_conversation', {
      taskId,
      channelId,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
