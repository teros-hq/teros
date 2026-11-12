import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const moveTask: ToolConfig = {
  description:
    'Move a task to a different column on the board. Returns: { task: { ...TASK_FIELDS } } (includes columnName + columnSlug after move). Use list-board-subscriptions + subscribe-to-board to get notified when tasks move.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      columnId: { type: 'string', description: 'Target column ID' },
      position: {
        type: 'number',
        description: 'Position within the column (optional, defaults to end)',
      },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
      reviewAction: {
        type: 'boolean',
        description:
          'Set true ONLY when this move is the terminal action of a review (verdict) while reacting to a task_moved→Review event. Enables the single-flight claim so concurrent sessions of yours move the task at most once. Leave unset for normal task management moves.',
      },
    },
    required: ['taskId', 'columnId'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const columnId = args?.columnId as string;
    if (!taskId || !columnId) throw new Error('taskId and columnId are required');

    const agentId = (context?.execution as any)?.agentId;
    if (!agentId) throw new Error('Agent ID not found in execution context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('move_task', {
        taskId,
        columnId,
        position: args?.position,
        agentId,
        ...(args?.reviewAction === true && { reviewAction: true }),
        // callerChannelId: per-call session identity for the single-flight
        // review claim (incident #23) — forwarded from the execution context.
        ...(context?.execution?.channelId && { callerChannelId: context.execution.channelId }),
      }),
      15_000,
      'move_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
