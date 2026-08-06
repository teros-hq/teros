import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFieldsList, withTimeout } from './utils';

export const batchCreateTasks: ToolConfig = {
  description:
    'Create multiple tasks atomically (all succeed or all fail). Max 100 per call. Returns: { projectId, tasks: [{ taskId, title, columnId, priority, tags }], count }. Use create-task for a single task. Providing `instructions` for each task is encouraged — it gives the assigned agent the context and steps needed to work autonomously.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      tasks: {
        type: 'array',
        description: 'Array of task objects (max 100)',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title' },
            description: { type: 'string', description: 'Short one-line summary of what the task is about (max ~1000 chars)' },
            instructions: { type: 'string', description: 'Detailed task instructions in markdown — context, specific steps, acceptance criteria, relevant paths, examples, and constraints. This is what the assigned agent receives as their briefing, so providing clear instructions is highly valuable for autonomous execution.' },
            priority: {
              type: 'string',
              enum: ['urgent', 'high', 'medium', 'low'],
              description: 'Priority (default: medium)',
            },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
            assignedAgentId: { type: 'string', description: 'Agent to assign' },
            columnId: { type: 'string', description: 'Target column (default: backlog)' },
            parentTaskId: { type: 'string', description: 'Parent task ID' },
          },
          required: ['title'],
        },
      },
      includeRaw: { type: 'boolean', description: 'Return full task documents' },
    },
    required: ['projectId', 'tasks'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    const rawTasks = args?.tasks;
    if (!projectId) throw new Error('projectId is required');
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      throw new Error('tasks array is required and must be non-empty');
    }
    if (rawTasks.length > 100) {
      throw new Error('batch-create-tasks accepts at most 100 tasks per call');
    }

    const result = await withTimeout(
      wsClient.queryConversations<any>('batch_create_tasks', {
        projectId,
        tasks: rawTasks,
      }),
      20_000,
      'batch_create_tasks',
    );

    const tasks = resolveFieldsList(result.tasks ?? [], {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });

    return { projectId, tasks, count: tasks.length };
  },
};
