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
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
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
  // One-time subscriptions auto-delete after the first matched dispatch.
  // Optional + default false for backward compatibility with existing documents.
  oneTime?: boolean;
  // Unified filter (v1.4.4 reserved _subscribe tools): field → values, fields
  // AND-ed, values OR-ed. Semantics come from the app's events.json filters
  // declaration, snapshotted into filterSpec at subscribe time so dispatch is
  // self-contained (the declaration can evolve without breaking live subs).
  filter?: UnifiedFilter;
  filterSpec?: DeclaredEventFilters;
  // Event types (full topics, e.g. 'gmail.email.received') that wake the
  // agent. Absent/empty = every matched event wakes (the historical default).
  wakeUpOn?: string[];
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
  // One-time subscriptions auto-delete after the first matched dispatch.
  // Optional + default false for backward compatibility with existing documents.
  oneTime?: boolean;
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
  // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
  // ensureAllIndexes after migrations. Kept for tests and scripts.
  await ensureCollectionIndexes(getChannelEventSubscriptionsCollection(db), COLLECTIONS.subscriptionsChannel);
  await ensureCollectionIndexes(getAgentEventSubscriptionsCollection(db), COLLECTIONS.subscriptionsAgent);
  await ensureCollectionIndexes(getSubscriptionCorrelationsCollection(db), COLLECTIONS.subscriptionsCorrelation);

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
// ============================================================================
// UNIFIED SUBSCRIPTION FILTERS (v1.4.4 — reserved _subscribe tools)
//
// The reserved per-MCA tools (`gmail__subscribe`, `board_manager__subscribe`…)
// use ONE filter contract across every app: an object of field → values where
// fields are AND-ed and values within a field are OR-ed. Each field's
// semantics (which payload field it tests, which operator) are DECLARED by the
// app in its events.json `filters` block — the backend evaluates them at
// dispatch time against the event payload. Nothing is hardcoded per app, so a
// new app gets filterable subscriptions by declaring, not by coding.
// ============================================================================

/**
 * A declared filter field. `mapsTo` names the payload field the filter tests
 * (defaults to the filter name); `operator` picks the comparison:
 *   - anyOf (default): payload value is an array → membership; scalar → equality
 *   - equals:          strict equality
 *   - contains:        payload string contains the value (case-insensitive)
 */
export interface DeclaredFilterField {
  type: 'string' | 'number' | 'boolean';
  operator?: 'anyOf' | 'equals' | 'contains';
  /** Payload field this filter maps to (defaults to the filter field name). */
  mapsTo?: string;
  description?: string;
}

/** filters block of a declared event: field name → declaration. */
export type DeclaredEventFilters = Record<string, DeclaredFilterField>;

/** The filter a subscriber sends: field → value or values (OR within field). */
export type UnifiedFilter = Record<string, unknown>;

/** Evaluate one declared field against a payload value. */
function filterValueMatches(decl: DeclaredFilterField, filterValue: unknown, payloadValue: unknown): boolean {
  const values = Array.isArray(filterValue) ? filterValue : [filterValue];
  const op = decl.operator ?? 'anyOf';
  if (op === 'contains') {
    const hay = typeof payloadValue === 'string' ? payloadValue : String(payloadValue ?? '');
    return values.some((v) => typeof v === 'string' && hay.toLowerCase().includes(v.toLowerCase()));
  }
  if (Array.isArray(payloadValue)) {
    // anyOf/equals against an array payload: membership
    return values.some((v) => payloadValue.includes(v as never));
  }
  return values.some((v) => payloadValue === v);
}

/**
 * Evaluate a unified filter (AND across fields, OR within values) against an
 * event payload using the app's declaration. Unknown filter fields are
 * rejected at subscribe time, never here; an empty filter always matches.
 */
export function unifiedFilterMatches(
  filter: UnifiedFilter | undefined,
  filterSpec: DeclaredEventFilters | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (!filterSpec) return false; // declared without filters → only empty filters match
  return Object.entries(filter).every(([field, value]) => {
    const decl = filterSpec[field];
    if (!decl) return false;
    const target = decl.mapsTo ?? field;
    return filterValueMatches(decl, value, payload[target]);
  });
}
