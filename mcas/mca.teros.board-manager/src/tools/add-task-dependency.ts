import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const addTaskDependency: ToolConfig = {
  description:
    'Add a dependency: after this call, taskId depends on dependsOnTaskId (dependsOnTaskId must complete first). Cycle detection runs automatically; if adding the edge would create a cycle, the call errors and affected tasks are marked circular_dependency. Returns: { task: { ...TASK_FIELDS, dependencies } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task that gains the new dependency (the dependent task)',
      },
      dependsOnTaskId: {
        type: 'string',
        description: 'Task that taskId will depend on (must complete first)',
      },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId', 'dependsOnTaskId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const dependsOnTaskId = args?.dependsOnTaskId as string;
    if (!taskId || !dependsOnTaskId) {
      throw new Error('taskId and dependsOnTaskId are required');
    }

    const result = await withTimeout(
      wsClient.queryConversations<any>('add_dependency', {
        taskId,
        dependsOnTaskId,
      }),
      15_000,
      'add_dependency',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
