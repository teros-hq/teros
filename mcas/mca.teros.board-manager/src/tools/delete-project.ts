import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { assertBackendConnected, withTimeout } from './utils';

export const deleteProject: ToolConfig = {
  description:
    'Permanently delete a project and all its tasks and board. Only workspace admin/owner can delete. Irreversible — prefer archive-project for soft-delete. Returns: { projectId, deleted: true }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID to delete' },
    },
    required: ['projectId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    if (!projectId) {
      throw new Error('projectId is required');
    }

    const result = await withTimeout(
      wsClient.queryConversations<any>('delete_project', {
        projectId,
      }),
      15_000,
      'delete_project',
    );

    return { projectId, deleted: true };
  },
};
