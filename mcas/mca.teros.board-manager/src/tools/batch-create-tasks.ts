import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, normalizeTags, resolveFieldsList, withTimeout } from './utils';

export const batchCreateTasks: ToolConfig = {
  description:
    'Create multiple tasks atomically (all succeed or all fail). Max 100 per call. Returns: { projectId, tasks: [{ taskId, title, columnId, priority, tags }], count }. Use create-task for a single task. `instructions` is required for each task — it gives the assigned agent the context and steps needed to work autonomously.',
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
          required: ['title', 'instructions'],
        },
      },
      includeRaw: { type: 'boolean', description: 'Return full task documents' },
    },
    required: ['projectId', 'tasks'],
  },
  handler: async (args, context) => {
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
    // Validate every task has instructions
    for (let i = 0; i < rawTasks.length; i++) {
      const t = rawTasks[i];
      if (!t?.instructions || String(t.instructions).trim().length === 0) {
        throw new Error(`Task at index ${i} is missing required "instructions" — provide detailed task instructions so the assigned agent can work autonomously`);
      }
    }

    // Normalize tags on every task (LLMs sometimes pass '["a","b"]' as string)
    const tasksPayload = rawTasks.map((t) => ({
      ...t,
      ...(t?.tags !== undefined ? { tags: normalizeTags(t.tags) } : {}),
    }));

    const callerAgentId = (context?.execution as any)?.agentId;
    if (!callerAgentId) throw new Error('Agent ID not found in execution context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('batch_create_tasks', {
        projectId,
        tasks: tasksPayload,
        callerAgentId,
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
