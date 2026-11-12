import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { PROJECT_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const updateProject: ToolConfig = {
  description:
    'Partial update of project properties (name, description, context). context is injected into agent system prompts when working on this project (markdown supported). Returns: { project: { ...PROJECT_FIELDS } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      name: { type: 'string', description: 'New name' },
      description: { type: 'string', description: 'New description' },
      context: {
        type: 'string',
        description:
          'Project context injected into agent system prompts (architecture notes, coding standards, etc.). Markdown supported.',
      },
      includeRaw: { type: 'boolean', description: 'Return full project document' },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const callerAgentId = (context?.execution as any)?.agentId;
    if (!callerAgentId) throw new Error('Agent ID not found in execution context');
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    if (!projectId) throw new Error('projectId is required');

    const result = await withTimeout(
      wsClient.queryConversations<any>('update_project', {
        projectId,
        name: args?.name,
        description: args?.description,
        context: args?.context,
        callerAgentId,
      }),
      15_000,
      'update_project',
    );

    const project = resolveFields(result.project ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: PROJECT_FIELDS,
    });
    return { project };
  },
};
