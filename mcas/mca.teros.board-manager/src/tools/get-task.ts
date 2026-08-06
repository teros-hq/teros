import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import {
  assertBackendConnected,
  attachAssigneeInfo,
  attachAssigneeInfoOne,
  resolveFields,
  resolveFieldsList,
  withRetry,
  withTimeout,
} from './utils';

export const getTask: ToolConfig = {
  description:
    'Get task detail + sub-tasks. Returns: { task: { taskId, title, description, columnName, columnSlug, priority, tags, assigneeName, running, stopRequested, dependencies, progressNotes, projectName, parentTaskTitle? }, subTasks: [...], agents }.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom subset of fields for task + subTasks',
      },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
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
        withTimeout(wsClient.queryConversations<any>('get_task', { taskId }), 15_000, 'get_task'),
      { retries: 2, delayMs: 500, label: 'get_task' },
    );

    const rawTask = result?.task;
    if (!rawTask) throw new Error(`Task ${taskId} not found`);

    const enrichedTask = attachAssigneeInfoOne(rawTask, result.agents);
    const enrichedSubTasks = attachAssigneeInfo(result.subTasks ?? [], result.agents);

    const includeRaw = args?.includeRaw === true;
    const fields = args?.fields as string[] | undefined;
    const task = resolveFields(enrichedTask, {
      includeRaw,
      fields,
      defaultFields: TASK_WITH_PROGRESS_FIELDS,
    });
    const subTasks = resolveFieldsList(enrichedSubTasks, {
      includeRaw,
      fields,
      defaultFields: TASK_WITH_PROGRESS_FIELDS,
    });

    return { task, subTasks, agents: result.agents ?? {} };
  },
};
