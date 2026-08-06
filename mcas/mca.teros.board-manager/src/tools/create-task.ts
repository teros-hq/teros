import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const createTask: ToolConfig = {
  description:
    'Create a task on a project board. Defaults to Backlog column. Returns: { task: { taskId, title, columnId, priority, tags, assignedAgentId } }. Use batch-create-tasks to create many atomically. Providing `instructions` is encouraged — it gives the assigned agent the context and steps needed to work autonomously.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      title: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Short one-line summary of what the task is about (max ~1000 chars)' },
      instructions: { type: 'string', description: 'Detailed task instructions in markdown — context, specific steps, acceptance criteria, relevant paths, examples, and constraints. This is what the assigned agent receives as their briefing, so providing clear instructions is highly valuable for autonomous execution.' },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'Priority (default: medium)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for categorization',
      },
      assignedAgentId: { type: 'string', description: 'Agent to assign' },
      columnId: { type: 'string', description: 'Target column (default: backlog)' },
      parentTaskId: { type: 'string', description: 'Parent task (for sub-tasks)' },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['projectId', 'title'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    const title = args?.title as string;
    if (!projectId || !title) throw new Error('projectId and title are required');

    const result = await withTimeout(
      wsClient.queryConversations<any>('create_task', {
        projectId,
        title,
        description: args?.description,
        instructions: args?.instructions,
        priority: args?.priority,
        tags: args?.tags,
        assignedAgentId: args?.assignedAgentId,
        columnId: args?.columnId,
        parentTaskId: args?.parentTaskId,
      }),
      15_000,
      'create_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
