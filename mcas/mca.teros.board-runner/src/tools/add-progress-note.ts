import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const addProgressNote: ToolConfig = {
  description:
    'Add a progress note to one of your assigned tasks. Notes are visible on the task detail and the board. Prefix with "PROPUESTA: " to suggest new tasks to the manager. Returns: { task: { ...TASK_WITH_PROGRESS_FIELDS } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      text: { type: 'string', description: 'Progress note text' },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId', 'text'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const text = args?.text as string;
    const agentId = context?.execution?.agentId;
    if (!taskId || !text) throw new Error('taskId and text are required');
    if (!agentId) throw new Error('Agent ID not found in context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('add_my_progress_note', { taskId, text, agentId }),
      15_000,
      'add_my_progress_note',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_WITH_PROGRESS_FIELDS,
    });
    return { task };
  },
};
