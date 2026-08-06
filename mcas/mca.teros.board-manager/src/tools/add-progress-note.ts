import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const addProgressNote: ToolConfig = {
  description:
    'Post a progress note on a task (manager action). Notes are visible on the task detail and the board. Returns: { task: { ...TASK_WITH_PROGRESS_FIELDS } }. Runner agents should use the board-runner add-progress-note instead.',
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
    if (!taskId || !text) throw new Error('taskId and text are required');

    const actor = context?.execution?.agentId || 'unknown';

    const result = await withTimeout(
      wsClient.queryConversations<any>('add_progress_note', {
        taskId,
        text,
        actor,
      }),
      15_000,
      'add_progress_note',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_WITH_PROGRESS_FIELDS,
    });
    return { task };
  },
};
