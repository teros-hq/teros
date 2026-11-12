import type { ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient } from '../lib';
import { EVENT_SUBSCRIPTION_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const subscribeToEvents: ToolConfig = {
  description:
    'DEPRECATED (v1.4.4): use the reserved per-app tools instead — `board_manager__subscribe` for this app\'s events, `<app>__subscribe` for any other app\'s (e.g. gmail__subscribe with event "email.received"). The reserved tools take the LOCAL event name, validate filters against the app\'s declaration and keep state in the backend. This tool still works (raw topic + rules) but will be removed. ' +
    'Subscribe the current conversation to MCA events on a topic. Events matching the topic are delivered to the conversation as they happen. Use rules to narrow events. Returns: { subscription: { id, topic, channelId, rules, mode, createdAt } }. Use unsubscribe-from-events to stop.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Event topic to subscribe to (e.g. "telegram.message.received")',
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
          'Delivery mode: notify = silent notification, wake = trigger agent response turn (the agent gets a response turn). Default: wake',
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

    const callerAgentId = (context?.execution as any)?.agentId;
    if (!callerAgentId) throw new Error('Agent ID not found in execution context');

    const result = await withTimeout(
      wsClient.queryConversations<any>('subscribe_to_events', {
        topic,
        channelId,
        rules: args?.rules,
        mode: args?.mode ?? 'wake',
        callerAgentId,
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
