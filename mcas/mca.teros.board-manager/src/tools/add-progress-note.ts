import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { TASK_WITH_PROGRESS_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const addProgressNote: ToolConfig = {
  description:
    'Post a progress note on a task (manager action). Notes are visible on the task detail and the board. Returns: { task: { ...TASK_WITH_PROGRESS_FIELDS } }. Runner agents should use the board-runner add-progress-note instead.',
  // safeWriteHint: owner decision (2026-10-01) — progress notes are append-only
  // reporting on a task; reversible and scoped to the user's own board activity.
  // The subscribe/unsubscribe tools deliberately do NOT carry this hint.
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
    if (!taskId || !text) throw new Error('taskId and text are required');

    const callerAgentId = (context?.execution as any)?.agentId;
    if (!callerAgentId) throw new Error('Agent ID not found in execution context');
    const actor = callerAgentId;

    const result = await withTimeout(
      wsClient.queryConversations<any>('add_progress_note', {
        taskId,
        text,
        actor,
        callerAgentId,
        ...(args?.reviewAction === true && { reviewAction: true }),
        // callerChannelId: per-call session identity for the single-flight
        // review claim (incident #23) — forwarded from the execution context.
        ...(context?.execution?.channelId && { callerChannelId: context.execution.channelId }),
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
