import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withRetry, withTimeout } from './utils';

export const removeTaskDependency: ToolConfig = {
  description:
    'Remove a dependency between two tasks. Idempotent — if the dependency does not exist, the task is returned unchanged. Returns: { task: { ...TASK_FIELDS, dependencies } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task that currently has the dependency' },
      dependsOnTaskId: {
        type: 'string',
        description: "Task to remove from taskId's dependencies",
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

    // Idempotent → safe to retry.
    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('remove_dependency', {
            taskId,
            dependsOnTaskId,
          }),
          15_000,
          'remove_dependency',
        ),
      { retries: 2, delayMs: 500, label: 'remove_dependency' },
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
