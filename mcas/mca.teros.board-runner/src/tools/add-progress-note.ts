import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const addProgressNote: ToolConfig = {
  description:
    'Add a progress note to one of your assigned tasks. Notes are visible on the task detail and the board. Prefix with "PROPUESTA: " to suggest new tasks to the manager. Returns: { task: { ...TASK_WITH_PROGRESS_FIELDS } }.',
  // safeWriteHint: critical for headless runners — these are the tools a runner
  // uses to report its work. If they ask permission in a conversation with no
  // human watching, nobody can approve and the runner deadlocks.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      text: { type: 'string', description: 'Progress note text' },
      includeRaw: { type: 'boolean', description: 'Return full task document' },
      reviewAction: {
        type: 'boolean',
        description:
          'Set true ONLY when this note is a review verdict posted while reacting to a task_moved→Review event. Enables the single-flight claim so concurrent sessions of yours post at most one review note. Leave unset for normal progress reporting.',
      },
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

    // callerChannelId: per-call session identity for the single-flight review
    // claim (incident #23). The backend's execution context carries the real
    // channelId of THIS conversation — forwarding it lets the claim tell apart
    // parallel sessions of the same agent. Without it the guard falls back to
    // a per-call anonymous id (fail-closed, but note→move correlation is lost).
    const callerChannelId = context?.execution?.channelId;
    const result = await withTimeout(
      wsClient.queryConversations<any>('add_my_progress_note', {
        taskId,
        text,
        agentId,
        ...(args?.reviewAction === true && { reviewAction: true }),
        ...(callerChannelId && { callerChannelId }),
      }),
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
