import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const completeMyTask: ToolConfig = {
  description:
    'Mark your assigned task complete. Moves it to Review (ready for manager review). Works from any column including Blocked. Clears the running flag. Returns: { task: { ...TASK_FIELDS, columnSlug: "review" } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const agentId = context?.execution?.agentId;
    if (!taskId) throw new Error('taskId is required');
    if (!agentId) throw new Error('Agent ID not found in context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('complete_my_task', { taskId, agentId }),
      15_000,
      'complete_my_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
