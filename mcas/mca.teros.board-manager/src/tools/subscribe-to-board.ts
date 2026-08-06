import type { ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, SENDER_AGENT_ID, getWsClient } from '../lib';
import { BOARD_SUBSCRIPTION_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const subscribeToBoard: ToolConfig = {
  description:
    'Subscribe the current conversation to real-time board events. Events (task moves, status changes, progress notes, dependency changes, autoplay toggles) are delivered to the conversation as they happen. Use filter to narrow events. Returns: { subscription: { subscriptionId, boardId, filter, createdAt } }. Use unsubscribe-from-board to stop.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      boardId: { type: 'string', description: 'Board ID to subscribe to' },
      filter: {
        type: 'object',
        description: 'Optional filter to narrow delivered events',
        properties: {
          agentIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only events for tasks assigned to these agents',
          },
          columnIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only events for tasks in these columns',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tasks with ALL these tags',
          },
          eventTypes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Valid: board.task_moved, board.task_status_changed, board.task_assigned, board.task_created, board.task_updated, board.task_progress_note, board.agent_play_changed, board.agent_slots_changed, board.dependency_added, board.dependency_removed',
          },
          wakeUpOn: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Event types that wake the agent (trigger a response turn). Default: board.task_progress_note',
          },
        },
      },
      includeRaw: { type: 'boolean', description: 'Return full subscription document' },
    },
    required: ['boardId'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const boardId = args?.boardId as string;
    if (!boardId) throw new Error('boardId is required');

    const channelId = (context?.execution as any)?.channelId ?? CURRENT_CHANNEL_ID;
    const agentId = (context?.execution as any)?.agentId ?? SENDER_AGENT_ID;
    if (!channelId) throw new Error('channelId not found in execution context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('subscribe_to_board', {
        boardId,
        channelId,
        agentId,
        filter: args?.filter,
      }),
      15_000,
      'subscribe_to_board',
    );

    // Shape the subscription as a single object (backend returns loose fields).
    const subscriptionPayload = {
      subscriptionId: result.subscriptionId,
      boardId: result.boardId ?? boardId,
      boardName: result.boardName,
      filter: result.filter,
      channelId,
      agentId,
      createdAt: result.createdAt,
    };
    const subscription = resolveFields(subscriptionPayload, {
      includeRaw: args?.includeRaw === true,
      defaultFields: BOARD_SUBSCRIPTION_FIELDS,
    });
    return { subscription };
  },
};
