import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient, WORKSPACE_ID } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, paginate, resolveFieldsList, withRetry, withTimeout } from './utils';

export const getMyTasks: ToolConfig = {
  description:
    'List tasks assigned to this agent across all projects in the workspace. Returns: { agentId, tasks: [{ taskId, title, columnName, columnSlug, priority, projectName, running, stopRequested }], nextCursor? }. Paginated: default 50, max 200. Use get-my-task for the active task in the current conversation.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'Workspace ID (optional, defaults to current workspace)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Return only tasks that have ALL these tags (optional). Useful for a cycle/release scope (e.g. ["cycle:sesion-20260412"]).',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom subset of fields',
      },
      includeRaw: { type: 'boolean', description: 'Return full task documents' },
      limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const workspaceId = (args?.workspaceId as string) || WORKSPACE_ID;
    if (!workspaceId) throw new Error('workspaceId is required and could not be resolved');

    const agentId = context?.execution?.agentId;
    if (!agentId) throw new Error('Agent ID not available in execution context');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('get_tasks_by_agent', {
            workspaceId,
            agentId,
            tags: args?.tags,
          }),
          15_000,
          'get_tasks_by_agent',
        ),
      { retries: 2, delayMs: 500, label: 'get_tasks_by_agent' },
    );

    const { items, nextCursor } = paginate(
      (result.tasks ?? []) as Record<string, unknown>[],
      args?.limit as number | undefined,
      args?.cursor as string | undefined,
    );
    const tasks = resolveFieldsList(items, {
      includeRaw: args?.includeRaw === true,
      fields: args?.fields as string[] | undefined,
      defaultFields: TASK_FIELDS,
    });

    return { agentId, tasks, ...(nextCursor ? { nextCursor } : {}) };
  },
};
