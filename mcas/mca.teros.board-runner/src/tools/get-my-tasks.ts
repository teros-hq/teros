import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected, WORKSPACE_ID } from '../lib';

export const getMyTasks: ToolConfig = {
  description: 'Get all tasks assigned to this agent across all projects in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'Workspace ID (optional, defaults to current workspace)',
      },
    },
  },
  handler: async (args, context) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const workspaceId = (args?.workspaceId as string) || WORKSPACE_ID;
    if (!workspaceId) {
      throw new Error('workspaceId is required and could not be resolved from context');
    }

    const agentId = context?.execution?.agentId;
    if (!agentId) {
      throw new Error('Agent ID not available in execution context');
    }

    const result = await wsClient.queryConversations<any>('get_tasks_by_agent', {
      workspaceId,
      agentId,
    });

    return {
      success: true,
      agentId,
      tasks: result.tasks,
      count: result.tasks?.length ?? 0,
    };
  },
};
