import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const archiveTask: ToolConfig = {
  description:
    'Archive or restore a task (manager action). archived=true takes the task out of the active board (done / cancelled / discarded); archived=false restores it and triggers autoplay rescheduling. Returns: { task: { ...TASK_FIELDS } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      archived: {
        type: 'boolean',
        description: 'true = archive, false = restore to active board',
      },
      archiveNote: {
        type: 'string',
        description: 'Optional note explaining why the task was archived',
      },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
    },
    required: ['taskId', 'archived'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const taskId = args?.taskId as string;
    const archived = args?.archived as boolean;
    if (!taskId || archived === undefined) {
      throw new Error('taskId and archived are required');
    }

    const actor = context?.execution?.agentId || 'unknown';

    const result = await withTimeout(
      wsClient.queryConversations<any>('archive_task', {
        taskId,
        archived,
        archiveNote: args?.archiveNote,
        actor,
      }),
      15_000,
      'archive_task',
    );

    const task = resolveFields(result.task ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: TASK_FIELDS,
    });
    return { task };
  },
};
