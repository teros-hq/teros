import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const moveTask: ToolConfig = {
  description:
    'Move a task to a different column on the board. Returns: { task: { ...TASK_FIELDS } } (includes columnName + columnSlug after move). Use list-board-subscriptions + subscribe-to-board to get notified when tasks move.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      columnId: { type: 'string', description: 'Target column ID' },
      position: {
        type: 'number',
        description: 'Position within the column (optional, defaults to end)',
      },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId', 'columnId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const columnId = args?.columnId as string;
    if (!taskId || !columnId) throw new Error('taskId and columnId are required');

    const result = await withTimeout(
      wsClient.queryConversations<any>('move_task', {
        taskId,
        columnId,
        position: args?.position,
      }),
      15_000,
      'move_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
