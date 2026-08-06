import type { ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient } from '../lib';
import { assertBackendConnected, withRetry, withTimeout } from './utils';

export const unsubscribeFromBoard: ToolConfig = {
  description:
    "Cancel this conversation's subscription to board events for a specific board. Idempotent — if no subscription exists, returns { boardId, unsubscribed: true } unchanged. Returns: { boardId, unsubscribed: true }.",
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      boardId: { type: 'string', description: 'Board ID to unsubscribe from' },
    },
    required: ['boardId'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const boardId = args?.boardId as string;
    if (!boardId) throw new Error('boardId is required');

    const channelId = (context?.execution as any)?.channelId ?? CURRENT_CHANNEL_ID;
    if (!channelId) throw new Error('channelId not found in execution context');

    // Idempotent → safe to retry.
    await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('unsubscribe_from_board', {
            boardId,
            channelId,
          }),
          15_000,
          'unsubscribe_from_board',
        ),
      { retries: 2, delayMs: 500, label: 'unsubscribe_from_board' },
    );

    return { boardId, unsubscribed: true };
  },
};
