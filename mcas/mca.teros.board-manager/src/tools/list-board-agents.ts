import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected, WORKSPACE_ID } from '../lib';

export const listBoardAgents: ToolConfig = {
  description:
    'List all agents in the workspace that have access to board-manager or board-runner apps, including their role (manager, runner, or both).',
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

    const result = await wsClient.queryConversations<any>('list_board_agents', { workspaceId });

    return {
      success: true,
      agents: result.agents,
      count: result.agents?.length ?? 0,
    };
  },
};
