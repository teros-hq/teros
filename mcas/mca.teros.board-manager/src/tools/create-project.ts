import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected, WORKSPACE_ID } from '../lib';

export const createProject: ToolConfig = {
  description: 'Create a new project with an associated Kanban board in a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to create the project in (optional, defaults to current workspace)',
      },
      name: {
        type: 'string',
        description: 'Project name',
      },
      description: {
        type: 'string',
        description: 'Optional project description',
      },
    },
    required: ['name'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const workspaceId = (args?.workspaceId as string) || WORKSPACE_ID;
    const name = args?.name as string;
    if (!workspaceId || !name) {
      throw new Error('workspaceId and name are required');
    }

    const result = await wsClient.queryConversations<any>('create_project', {
      workspaceId,
      name,
      description: args?.description,
    });

    return {
      success: true,
      project: result.project,
      board: result.board,
    };
  },
};
