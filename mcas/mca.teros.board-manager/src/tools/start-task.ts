import type { ToolConfig, ToolContext } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const startTask: ToolConfig = {
  description:
    'Start a task: moves to in_progress, creates a headless conversation with the assigned agent, sends the task description as the first message, and links the conversation to the task. Returns: { task: { ...TASK_FIELDS, channelId }, channelId }. Optional override of agent or prompt.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      agentId: {
        type: 'string',
        description: 'Optional agent override. Reassigns the task before starting.',
      },
      prompt: {
        type: 'string',
        description:
          'Optional custom prompt. Overrides the default task description as the first message.',
      },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId'],
  },
  handler: async (args, context: ToolContext) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    if (!taskId) throw new Error('taskId is required');

    // Capture caller channel at call time — safe under parallel invocations
    const callerChannelId = context.execution.channelId;

    const result = await withTimeout(
      wsClient.queryConversations<any>('start_task', {
        taskId,
        agentId: args?.agentId,
        prompt: args?.prompt,
        ...(callerChannelId && { callerChannelId }),
      }),
      20_000,
      'start_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task, ...(result.channelId ? { channelId: result.channelId } : {}) };
  },
};
