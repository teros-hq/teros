import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const getProject: ToolConfig = {
  description: 'Get detailed information about a project, including its board columns with their IDs.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to retrieve',
      },
    },
    required: ['projectId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const projectId = args?.projectId as string;
    if (!projectId) {
      throw new Error('projectId is required');
    }

    const result = await wsClient.queryConversations<any>('get_project', { projectId });

    return {
      success: true,
      project: result.project,
      board: result.board,
    };
  },
};
