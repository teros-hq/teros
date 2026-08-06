import type { ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient } from '../lib';
import { EVENT_SUBSCRIPTION_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const subscribeToEvents: ToolConfig = {
  description:
    'Subscribe the current conversation to MCA events on a topic. Events matching the topic are delivered to the conversation as they happen. Use rules to narrow events. Returns: { subscription: { id, topic, channelId, rules, mode, createdAt } }. Use unsubscribe-from-events to stop.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Event topic to subscribe to (e.g. "mca.teros.scheduler.reminder")',
      },
      channelId: {
        type: 'string',
        description: 'Channel ID to receive events in (defaults to current conversation)',
      },
      rules: {
        type: 'array',
        description: 'Optional filter rules to narrow delivered events',
        items: { type: 'object' },
      },
      mode: {
        type: 'string',
        enum: ['notify', 'wake'],
        description:
          'Delivery mode: notify = silent notification, wake = trigger agent response turn. Default: notify',
      },
      includeRaw: { type: 'boolean', description: 'Return full subscription document' },
    },
    required: ['topic'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const topic = args?.topic as string;
    if (!topic) throw new Error('topic is required');

    const channelId =
      (args?.channelId as string) ??
      (context?.execution as any)?.channelId ??
      CURRENT_CHANNEL_ID;
    if (!channelId) throw new Error('channelId not found in execution context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('subscribe_to_events', {
        topic,
        channelId,
        rules: args?.rules,
        mode: args?.mode ?? 'notify',
      }),
      15_000,
      'subscribe_to_events',
    );

    // Shape the subscription as a single object (backend returns loose fields).
    const subscriptionPayload = {
      id: result.subscription.id,
      topic: result.subscription.topic,
      channelId: result.subscription.channelId,
      rules: result.subscription.rules,
      mode: result.subscription.mode,
      createdAt: result.subscription.createdAt,
    };
    const subscription = resolveFields(subscriptionPayload, {
      includeRaw: args?.includeRaw === true,
      defaultFields: EVENT_SUBSCRIPTION_FIELDS,
    });
    return { subscription };
  },
};
