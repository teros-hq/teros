import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient, CURRENT_CHANNEL_ID } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withRetry, withTimeout } from './utils';

export const getMyTask: ToolConfig = {
  description:
    'Get the task linked to the current conversation (fast path). Returns: { channelId, task: { taskId, title, columnName, columnSlug, running, stopRequested, projectName, progressNotes } | null }. Check stopRequested at every turn; if true, finish current step, add a progress note, call block-my-task, and stop.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      fields: { type: 'array', items: { type: 'string' }, description: 'Custom subset of fields' },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const agentId = context?.execution?.agentId;
    if (!agentId) throw new Error('Agent ID not found in context');

    const channelId = context?.execution?.channelId || CURRENT_CHANNEL_ID;
    if (!channelId) throw new Error('Channel ID not available in context');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('get_my_task', { channelId, agentId }),
          15_000,
          'get_my_task',
        ),
      { retries: 2, delayMs: 500, label: 'get_my_task' },
    );

    const rawTask = result?.task;
    if (!rawTask) return { channelId, task: null };

    const task = resolveFields(rawTask as Record<string, unknown>, {
      includeRaw: args?.includeRaw === true,
      fields: args?.fields as string[] | undefined,
      defaultFields: TASK_WITH_PROGRESS_FIELDS,
    });
    return { channelId, task };
  },
};
