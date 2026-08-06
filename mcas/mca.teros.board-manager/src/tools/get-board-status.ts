import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { BOARD_STATUS_AGENT_FIELDS } from './_fields';
import { assertBackendConnected, pickFieldsList, withRetry, withTimeout } from './utils';

export const getBoardStatus: ToolConfig = {
  description:
    'Operational status of a board: per-agent workload + summary. Returns: { boardId, boardName, agents: [{ agentName, slots, playEnabled, tasksInProgress, tasksInReview, tasksBlocked, tasksToDo }], summary: { total, byColumn, blockedTasks } }. Use to identify bottlenecks.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      boardId: { type: 'string', description: 'Board ID' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom subset for per-agent rows',
      },
      includeRaw: { type: 'boolean', description: 'Return the full backend payload' },
    },
    required: ['boardId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const boardId = args?.boardId as string;
    if (!boardId) throw new Error('boardId is required');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('get_board_status', { boardId }),
          15_000,
          'get_board_status',
        ),
      { retries: 2, delayMs: 500, label: 'get_board_status' },
    );

    if (args?.includeRaw === true) return result;

    const fields =
      (args?.fields as string[] | undefined) && (args?.fields as string[]).length > 0
        ? (args?.fields as string[])
        : BOARD_STATUS_AGENT_FIELDS;
    const agents = pickFieldsList(result.agents ?? [], fields);

    return {
      boardId: result.boardId ?? boardId,
      boardName: result.boardName,
      agents,
      summary: result.summary,
    };
  },
};
