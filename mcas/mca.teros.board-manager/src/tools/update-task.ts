import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const updateTask: ToolConfig = {
  description:
    'Partial update of task properties. Omitted fields unchanged. Returns: { task: { ...TASK_FIELDS } }. To move a task between columns use move-task. To assign an agent use assign-task.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New short one-line summary of what the task is about (max ~1000 chars)' },
      instructions: { type: 'string', description: 'New detailed task instructions in markdown — context, specific steps, acceptance criteria, relevant paths, examples, and constraints. This is what the assigned agent receives as their briefing, so providing clear instructions is highly valuable for autonomous execution.' },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'New priority',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'New tags (replaces existing)',
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

    const result = await withTimeout(
      wsClient.queryConversations<any>('update_task', {
        taskId,
        title: args?.title,
        description: args?.description,
        instructions: args?.instructions,
        priority: args?.priority,
        tags: args?.tags,
      }),
      15_000,
      'update_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
