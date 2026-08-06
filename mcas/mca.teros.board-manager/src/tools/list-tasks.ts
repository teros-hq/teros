import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import {
  assertBackendConnected,
  attachAssigneeInfo,
  paginate,
  resolveFieldsList,
  withRetry,
  withTimeout,
} from './utils';

export const listTasks: ToolConfig = {
  description:
    'List tasks in a project. Returns: { projectId, projectName, tasks: [{ taskId, title, columnName, columnSlug, priority, archived, tags, running, assigneeName, assigneeAvatarUrl }], agents, nextCursor? }. Paginated: default 50, max 200. For agent-view of own tasks use get-my-tasks (runner MCA).',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      columnId: { type: 'string', description: 'Filter by column (optional)' },
      assignedAgentId: { type: 'string', description: 'Filter by assignee (optional)' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Return only tasks that have ALL these tags (optional)',
      },
      archived: {
        type: 'boolean',
        description: 'true=archived only, false=active only (default: active)',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom subset of fields to return (overrides default whitelist)',
      },
      includeRaw: { type: 'boolean', description: 'Return full task documents' },
      limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      cursor: { type: 'string', description: 'Pagination cursor from previous response' },
    },
    required: ['projectId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    if (!projectId) throw new Error('projectId is required');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('list_tasks', {
            projectId,
            columnId: args?.columnId,
            assignedAgentId: args?.assignedAgentId,
            tags: args?.tags,
            archived: args?.archived,
          }),
          15_000,
          'list_tasks',
        ),
      { retries: 2, delayMs: 500, label: 'list_tasks' },
    );

    const withAssignees = attachAssigneeInfo(result.tasks ?? [], result.agents);
    const { items, nextCursor } = paginate(
      withAssignees,
      args?.limit as number | undefined,
      args?.cursor as string | undefined,
    );
    const tasks = resolveFieldsList(items, {
      includeRaw: args?.includeRaw === true,
      fields: args?.fields as string[] | undefined,
      defaultFields: TASK_FIELDS,
    });

    return {
      projectId: result.projectId ?? projectId,
      ...(result.projectName ? { projectName: result.projectName } : {}),
      tasks,
      agents: result.agents ?? {},
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};
