/**
 * MCA Event Subscriptions Models
 *
 * Three MongoDB collections for the high-level MCA event subscription system:
 *
 * - subscriptions_channel: routes MCA events into an existing conversation
 * - subscriptions_agent:   routes MCA events to an agent (creates new conversations)
 * - subscriptions_correlation: maps correlation values to conversations (for agent subscriptions)
 *
 * Topics use namespaced strings with optional wildcards:
 *   - "gmail.email.received"  — exact match
 *   - "channel:turn_end"      — channel namespace, exact event
 *   - "channel:*"             — channel namespace, any event
 *   - "*"                     — any topic from any MCA
 *
 * Rules are an OR array of objects. Each object is evaluated by the MCA (typically AND).
 * The framework only enforces the OR semantics across objects.
 *
 * Example rules:
 *   [{ from: "alice@example.com" }, { starred: true }]
 *   → matches if from=alice OR starred=true
 *
 *   [{ from: "alice@example.com", starred: true }]
 *   → matches if from=alice AND starred=true (MCA decides)
 */

import type { Collection, Db } from 'mongodb';
import { nanoid } from 'nanoid';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A rule object — a set of key-value conditions evaluated by the MCA.
 * Multiple fields within the same object are typically AND (MCA decides).
 */
export type RuleObject = Record<string, unknown>;

/**
 * Rules array — evaluated as OR by the framework.
 * An empty array means "always match".
 */
export type Rules = RuleObject[];

/**
 * A channel subscription routes MCA events into an existing conversation.
 */
export interface ChannelEventSubscription {
  id: string;
  topic: string;              // e.g. "gmail.email.received", "channel:turn_end", "channel:*"
  channelId: string;          // existing conversation to receive the event
  rules: Rules;               // empty = always match; non-empty = OR of rule objects
  mode: 'notify' | 'wake';   // notify: inject event only; wake: inject + force agent response
  createdAt: Date;
  lastActivityAt: Date;       // updated on every matched dispatch; used for sliding TTL
}

/**
 * An agent subscription routes MCA events to an agent, creating new conversations.
 * Always behaves as "wake".
 */
export interface AgentEventSubscription {
  id: string;
  topic: string;              // e.g. "intercom.conversation.created"
  agentId: string;            // agent that will handle the event
  rules: Rules;               // same semantics as ChannelEventSubscription
  correlationKey: string;     // field in the event payload to group events into the same conversation
  createdAt: Date;
}

/**
 * Maps a correlation value to the conversation created for it.
 * Used exclusively by agent subscriptions.
 */
export interface SubscriptionCorrelation {
  id: string;
  subscriptionId: string;     // references AgentEventSubscription.id
  correlationValue: string;   // the concrete value of correlationKey (e.g. "clientId:xyz")
  channelId: string;          // the conversation created for this value
  createdAt: Date;
}

// ============================================================================
// COLLECTION HELPERS
// ============================================================================

export function getChannelEventSubscriptionsCollection(db: Db): Collection<ChannelEventSubscription> {
  return db.collection<ChannelEventSubscription>('subscriptions_channel');
}

export function getAgentEventSubscriptionsCollection(db: Db): Collection<AgentEventSubscription> {
  return db.collection<AgentEventSubscription>('subscriptions_agent');
}

export function getSubscriptionCorrelationsCollection(db: Db): Collection<SubscriptionCorrelation> {
  return db.collection<SubscriptionCorrelation>('subscriptions_correlation');
}

/**
 * Ensure all indexes for the MCA event subscription collections.
 * Call once at startup.
 */
export async function ensureMcaEventSubscriptionIndexes(db: Db): Promise<void> {
  // subscriptions_channel
  const channelCol = getChannelEventSubscriptionsCollection(db);
  await channelCol.createIndex({ topic: 1 }, { name: 'topic_lookup' });
  await channelCol.createIndex({ channelId: 1 }, { name: 'channel_lookup' });
  await channelCol.createIndex({ topic: 1, channelId: 1 }, { name: 'topic_channel_lookup' });
  // Note: the TTL index on lastActivityAt is managed by migration
  // 20260318_001_add_ttl_index_subscriptions_channel — do not recreate it here.

  // subscriptions_agent
  const agentCol = getAgentEventSubscriptionsCollection(db);
  await agentCol.createIndex({ topic: 1 }, { name: 'topic_lookup' });
  await agentCol.createIndex({ agentId: 1 }, { name: 'agent_lookup' });

  // subscriptions_correlation
  const corrCol = getSubscriptionCorrelationsCollection(db);
  await corrCol.createIndex(
    { subscriptionId: 1, correlationValue: 1 },
    { unique: true, name: 'unique_correlation' },
  );
  await corrCol.createIndex({ channelId: 1 }, { name: 'channel_lookup' });

  console.log('[MCAEventSubscriptions] MongoDB indexes ensured for subscriptions_channel/agent/correlation');
}

// ============================================================================
// ID HELPERS
// ============================================================================

export function generateSubscriptionId(): string {
  return `sub_${nanoid()}`;
}

export function generateCorrelationId(): string {
  return `cor_${nanoid()}`;
}

// ============================================================================
// TOPIC MATCHING
// ============================================================================

/**
 * Check whether a topic matches a subscription topic pattern.
 * Supports wildcards:
 *   - "*"           matches any topic
 *   - "channel:*"   matches any topic starting with "channel:"
 *   - "channel:foo" exact match
 *
 * The "*" can only appear at the end after a ":" separator.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*') return true;
  if (pattern === topic) return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1); // e.g. "channel:"
    return topic.startsWith(prefix);
  }
  return false;
}
