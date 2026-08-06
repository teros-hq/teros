import type { ToolConfig } from '@teros/mca-sdk';
import { SENDER_AGENT_ID, getWsClient } from '../lib';
import { assertBackendConnected, withTimeout } from './utils';

export const stopTask: ToolConfig = {
  description:
    'Send cooperative stop signal to a running task (task.running=true). The assigned runner agent finishes its current step, then moves the task to Blocked. Cooperative — the signal is processed at the next runner turn. Only managers should call this. Returns: { taskId, stopRequested: true }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID of a running task' },
      reason: {
        type: 'string',
        description: 'Optional human-readable reason delivered to the runner',
      },
    },
    required: ['taskId'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    if (!taskId) throw new Error('taskId is required');

    const agentId = (context?.execution as any)?.agentId ?? SENDER_AGENT_ID;

    const result = await withTimeout(
      wsClient.queryConversations<any>('stop_task', {
        taskId,
        reason: args?.reason,
        agentId,
      }),
      15_000,
      'stop_task',
    );

    return {
      taskId: result?.taskId ?? taskId,
      stopRequested: true,
      ...(args?.reason ? { reason: args.reason } : {}),
    };
  },
};
