import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected, WORKSPACE_ID } from '../lib';

export const listProjects: ToolConfig = {
  description: 'List all projects in a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID (optional, defaults to current workspace)',
      },
    },
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const workspaceId = (args?.workspaceId as string) || WORKSPACE_ID;
    if (!workspaceId) {
      throw new Error('workspaceId is required');
    }

    const result = await wsClient.queryConversations<any>('list_projects', { workspaceId });

    return {
      success: true,
      projects: result.projects,
      count: result.projects?.length ?? 0,
    };
  },
};
