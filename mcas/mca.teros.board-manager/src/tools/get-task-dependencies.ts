import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_DEPENDENCY_FIELDS } from './_fields';
import { assertBackendConnected, paginate, pickFields, withRetry, withTimeout } from './utils';

export const getTaskDependencies: ToolConfig = {
  description:
    'Get dependencies of a task (tasks that must complete before it can start). Returns: { taskId, dependencies: [{ taskId, title, columnSlug, priority, archived }], count, nextCursor? }. Paginated when large: default 50, max 200.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID whose dependencies to list' },
      limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
    required: ['taskId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    if (!taskId) throw new Error('taskId is required');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('get_task', { taskId }),
          15_000,
          'get_task_dependencies',
        ),
      { retries: 2, delayMs: 500, label: 'get_task_dependencies' },
    );

    const depIds: string[] = result?.task?.dependencies ?? [];
    if (depIds.length === 0) {
      return { taskId, dependencies: [], count: 0 };
    }

    // Resolve each dependency task in parallel with timeout (read-only, safe).
    const resolved = await Promise.all(
      depIds.map(async (id) => {
        try {
          const r = await withTimeout(
            wsClient.queryConversations<any>('get_task', { taskId: id }),
            10_000,
            'get_task(dep)',
          );
          return r?.task ?? { taskId: id };
        } catch {
          return { taskId: id };
        }
      }),
    );

    const { items, nextCursor } = paginate(
      resolved,
      args?.limit as number | undefined,
      args?.cursor as string | undefined,
    );
    const dependencies = items.map((t: any) => pickFields(t, TASK_DEPENDENCY_FIELDS));

    return {
      taskId,
      dependencies,
      count: dependencies.length,
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};
