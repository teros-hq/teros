import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { assertBackendConnected, withTimeout } from './utils';

export const deleteTask: ToolConfig = {
  description:
    'Permanently delete a task. Sub-tasks become top-level tasks. Linked conversations are NOT deleted. Irreversible. Returns: { taskId, deleted: true }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID to delete' },
    },
    required: ['taskId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    if (!taskId) throw new Error('taskId is required');

    await withTimeout(
      wsClient.queryConversations<any>('delete_task', { taskId }),
      15_000,
      'delete_task',
    );

    return { taskId, deleted: true };
  },
};
