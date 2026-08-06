import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const linkConversation: ToolConfig = {
  description:
    'Link an existing conversation (channel) to a task. Replaces any previously linked channel. Returns: { task: { ...TASK_FIELDS, channelId } }. Use start-task to link a new headless conversation instead.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      channelId: { type: 'string', description: 'Channel ID to link' },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId', 'channelId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const channelId = args?.channelId as string;
    if (!taskId || !channelId) throw new Error('taskId and channelId are required');

    const result = await withTimeout(
      wsClient.queryConversations<any>('link_conversation', {
        taskId,
        channelId,
      }),
      15_000,
      'link_conversation',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
