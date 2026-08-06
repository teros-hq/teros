import type { ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient } from '../lib';
import { EVENT_SUBSCRIPTION_FIELDS } from './_fields';
import { assertBackendConnected, paginate, resolveFieldsList, withRetry, withTimeout } from './utils';

export const listEventSubscriptions: ToolConfig = {
  description:
    'List active event subscriptions for a channel. Returns: { subscriptions: [{ id, topic, channelId, rules, mode, createdAt, lastActivityAt }], nextCursor? }. Paginated: default 50, max 200.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'Channel ID to list subscriptions for (defaults to current conversation)',
      },
      fields: { type: 'array', items: { type: 'string' }, description: 'Custom fields' },
      includeRaw: { type: 'boolean', description: 'Return full subscription documents' },
      limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const channelId =
      (args?.channelId as string) ??
      (context?.execution as any)?.channelId ??
      CURRENT_CHANNEL_ID;
    if (!channelId) throw new Error('channelId not found in execution context');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('list_event_subscriptions', { channelId }),
          15_000,
          'list_event_subscriptions',
        ),
      { retries: 2, delayMs: 500, label: 'list_event_subscriptions' },
    );

    const { items, nextCursor } = paginate(
      (result.subscriptions ?? []) as Record<string, unknown>[],
      args?.limit as number | undefined,
      args?.cursor as string | undefined,
    );
    const subscriptions = resolveFieldsList(items, {
      includeRaw: args?.includeRaw === true,
      fields: args?.fields as string[] | undefined,
      defaultFields: EVENT_SUBSCRIPTION_FIELDS,
    });

    return { subscriptions, ...(nextCursor ? { nextCursor } : {}) };
  },
};
