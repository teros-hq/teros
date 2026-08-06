import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { assertBackendConnected, withRetry, withTimeout } from './utils';

export const unsubscribeFromEvents: ToolConfig = {
  description:
    'Delete a channel event subscription by ID. Returns: { deleted: true }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Subscription ID to delete' },
    },
    required: ['id'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const id = args?.id as string;
    if (!id) throw new Error('id is required');

    // Idempotent → safe to retry.
    await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('unsubscribe_from_events', { id }),
          15_000,
          'unsubscribe_from_events',
        ),
      { retries: 2, delayMs: 500, label: 'unsubscribe_from_events' },
    );

    return { deleted: true };
  },
};
