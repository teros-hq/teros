import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const cancelMyTask: ToolConfig = {
  description:
    'Cancel your assigned task. Archives in-place (does not move column) + adds a progress note with the reason. Clears running. Use when the task is no longer needed, is a duplicate, or cannot be completed. Returns: { task: { ...TASK_WITH_PROGRESS_FIELDS, archived: true } }.',
  annotations: { readOnlyHint: false, irreversible: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      reason: {
        type: 'string',
        description: 'Why the task is cancelled (added as a progress note)',
      },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId', 'reason'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const reason = args?.reason as string;
    const agentId = context?.execution?.agentId;
    if (!taskId || !reason) throw new Error('taskId and reason are required');
    if (!agentId) throw new Error('Agent ID not found in context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('cancel_my_task', { taskId, reason, agentId }),
      15_000,
      'cancel_my_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_WITH_PROGRESS_FIELDS,
    });
    return { task };
  },
};
