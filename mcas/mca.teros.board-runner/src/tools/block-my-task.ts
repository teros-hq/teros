import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const blockMyTask: ToolConfig = {
  description:
    'Mark your assigned task blocked. Moves it to Blocked + adds a progress note with the reason. Clears running. Use for dependencies, missing info, or external blockers. Returns: { task: { ...TASK_WITH_PROGRESS_FIELDS, columnSlug: "blocked" } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      reason: {
        type: 'string',
        description: 'Why the task is blocked (added as a progress note)',
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
      wsClient.queryConversations<any>('block_my_task', { taskId, reason, agentId }),
      15_000,
      'block_my_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_WITH_PROGRESS_FIELDS,
    });
    return { task };
  },
};
