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
import { COLLECTIONS, ensureCollectionIndexes } from '../db';

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
  // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
  // ensureAllIndexes after migrations. Kept for tests and scripts.
  await ensureCollectionIndexes(getChannelSubscriptionsCollection(db), COLLECTIONS.channelSubscriptions);

  console.log('[ChannelSubscriptions] MongoDB indexes ensured for channel_subscriptions');
}
