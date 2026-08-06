import type { ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient } from '../lib';
import { BOARD_SUBSCRIPTION_FIELDS } from './_fields';
import { assertBackendConnected, paginate, resolveFieldsList, withRetry, withTimeout } from './utils';

export const listBoardSubscriptions: ToolConfig = {
  description:
    'List active board subscriptions for the current conversation. Returns: { subscriptions: [{ subscriptionId, boardId, boardName, filter, createdAt }], nextCursor? }. Paginated: default 50, max 200.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      fields: { type: 'array', items: { type: 'string' }, description: 'Custom fields' },
      includeRaw: { type: 'boolean', description: 'Return full subscription documents' },
      limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const channelId = (context?.execution as any)?.channelId ?? CURRENT_CHANNEL_ID;
    if (!channelId) throw new Error('channelId not found in execution context');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('list_board_subscriptions', { channelId }),
          15_000,
          'list_board_subscriptions',
        ),
      { retries: 2, delayMs: 500, label: 'list_board_subscriptions' },
    );

    const { items, nextCursor } = paginate(
      (result.subscriptions ?? []) as Record<string, unknown>[],
      args?.limit as number | undefined,
      args?.cursor as string | undefined,
    );
    const subscriptions = resolveFieldsList(items, {
      includeRaw: args?.includeRaw === true,
      fields: args?.fields as string[] | undefined,
      defaultFields: BOARD_SUBSCRIPTION_FIELDS,
    });

    return { subscriptions, ...(nextCursor ? { nextCursor } : {}) };
  },
};
