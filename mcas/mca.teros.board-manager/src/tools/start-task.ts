import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const startTask: ToolConfig = {
  description: 'Start a task: moves it to in_progress, creates a headless conversation with the assigned agent, sends the task description as the initial message, and links the conversation to the task. Optionally override the assigned agent or provide a custom prompt.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to start',
      },
      agentId: {
        type: 'string',
        description: 'Optional agent ID override. If provided, the task will be reassigned to this agent before starting.',
      },
      prompt: {
        type: 'string',
        description: 'Optional custom prompt to send to the agent instead of the default task description message.',
      },
    },
    required: ['taskId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    if (!taskId) {
      throw new Error('taskId is required');
    }

    const result = await wsClient.queryConversations<any>('start_task', {
      taskId,
      agentId: args?.agentId,
      prompt: args?.prompt,
    });

    return {
      success: true,
      task: result.task,
      channelId: result.channelId,
    };
  },
};
