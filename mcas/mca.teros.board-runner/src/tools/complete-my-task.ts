import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const completeMyTask: ToolConfig = {
  description:
    'Mark your assigned task complete. Moves it to Review (ready for manager review). Works from any column including Blocked. Clears the running flag. Returns: { task: { ...TASK_FIELDS, columnSlug: "review" } }. If the task was created by a workflow, pass outputData with the artifact data produced by the task — it will be saved to workflowOutputData before the workflow engine advances.',
  // safeWriteHint: critical for headless runners — these are the tools a runner
  // uses to report its work. If they ask permission in a conversation with no
  // human watching, nobody can approve and the runner deadlocks.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.1.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      outputData: {
        type: 'object',
        description:
          'Optional output data produced by the task (the deliverable). ' +
          'When the task is linked to a workflow execution, this data is ' +
          'validated against the output gate artifact schema before the ' +
          'workflow advances. Omit for non-workflow tasks.',
      },
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

    const queryArgs: Record<string, unknown> = { taskId, agentId };
    if (args?.outputData !== undefined && args?.outputData !== null) {
      queryArgs.outputData = args.outputData;
    }

    const result = await withTimeout(
      wsClient.queryConversations<any>('complete_my_task', queryArgs),
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
