import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const updateProject: ToolConfig = {
  description:
    'Update project properties including name, description, and context that gets injected into agent system prompts.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to update',
      },
      name: {
        type: 'string',
        description: 'New project name',
      },
      description: {
        type: 'string',
        description: 'New project description',
      },
      context: {
        type: 'string',
        description:
          'Project-specific context that gets injected into agent system prompts when working on this project. Use this to provide project requirements, coding standards, architecture notes, or any context agents should know. Supports markdown.',
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

    const result = await wsClient.queryConversations<any>('update_project', {
      projectId,
      name: args?.name,
      description: args?.description,
      context: args?.context,
    });

    return {
      success: true,
      project: result.project,
    };
  },
};
