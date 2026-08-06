/**
 * Channel Subscriptions Model
 *
 * Persistent MongoDB model for channel-to-channel subscriptions.
 * Replaces the subscription role of `originChannelId`.
 *
 * A "subscription" means: subscriberChannelId is observing observedChannelId.
 * When observedChannelId emits channel_started / channel_finished events,
 * they are fanned out to all subscriberChannelIds.
 *
 * The `originChannelId` field on Channel documents is kept as a structural
 * (parent-child hierarchy) field only — it is NOT used for event fanout.
 */

import type { Collection, Db } from 'mongodb';

// ============================================================================
// TYPES
// ============================================================================

export interface ChannelSubscription {
  subscriberChannelId: string; // The channel that wants to receive events
  observedChannelId: string;   // The channel being watched
  createdAt: Date;
}

// ============================================================================
// COLLECTION HELPERS
// ============================================================================

/**
 * Get the channel_subscriptions collection from a Db instance.
 */
export function getChannelSubscriptionsCollection(db: Db): Collection<ChannelSubscription> {
  return db.collection<ChannelSubscription>('channel_subscriptions');
}

/**
 * Ensure required indexes exist on the channel_subscriptions collection.
 * Must be called once at startup (e.g. in bootstrap or PubSubService.init).
 */
export async function ensureChannelSubscriptionIndexes(db: Db): Promise<void> {
  const col = getChannelSubscriptionsCollection(db);

  // Unique compound index — prevents duplicate subscriptions
  await col.createIndex(
    { subscriberChannelId: 1, observedChannelId: 1 },
    { unique: true, name: 'unique_subscription' },
  );

  // Index for getObservers(observedChannelId) — the hot read path
  await col.createIndex(
    { observedChannelId: 1 },
    { name: 'observed_channel_lookup' },
  );

  // Index for listing all subscriptions of a subscriber
  await col.createIndex(
    { subscriberChannelId: 1 },
    { name: 'subscriber_channel_lookup' },
  );

  console.log('[ChannelSubscriptions] MongoDB indexes ensured for channel_subscriptions');
}
