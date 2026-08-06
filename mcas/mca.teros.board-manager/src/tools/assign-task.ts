import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const assignTask: ToolConfig = {
  description:
    'Assign or unassign an agent to a task. Pass agentId to assign, omit or null to unassign. Returns: { task: { ...TASK_FIELDS } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      agentId: { type: 'string', description: 'Agent ID (omit or null to unassign)' },
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
      wsClient.queryConversations<any>('assign_task', {
        taskId,
        agentId: args?.agentId ?? null,
      }),
      15_000,
      'assign_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
