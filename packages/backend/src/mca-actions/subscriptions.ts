/**
 * subscriptions actions — the unified subscription API (v1.4.4).
 *
 * One API for every MCA with events. The reserved tools each app exposes
 * (`gmail__subscribe`, `board_manager__subscribe`, `todo_list__subscribe`…)
 * forward here through the authenticated callback as
 * `subscriptions/subscribe|unsubscribe|list`. The calling MCA's identity comes
 * from the verified token; the topic must be declared by THAT MCA (its
 * mca_catalog `events` entry — synced from manifest.json or events.json), so
 * the declaration doubles as the allowlist: an MCA can only subscribe
 * conversations to its own events. Filter fields are validated against the
 * declared `filters` block — an undeclared field is a clear INVALID_FILTER
 * error, never a silent never-matching subscription.
 *
 * State lives ONLY here (subscriptions_channel via MCAEventSubscriptionService)
 * — MCAs are ephemeral (spawn/despawn on demand), so a subscription created
 * through one process survives its respawn and is served by the next one.
 * Delivery reuses the generic bus dispatch: wake or notify into the channel,
 * self-wake guard included.
 *
 * This capability is SHARED (mcaId '*'): unlike the per-mcaId capabilities, it
 * is available to every MCA that declares events — the dispatcher checks the
 * declaration before any handler runs, which is the authorization.
 */

import type { Db } from 'mongodb';
import { McaActionError } from './errors';
import type { McaActionCtx, McaActionHandler } from './index';
import type { DeclaredEventFilters, UnifiedFilter } from '../models/mca-event-subscriptions';

// ============================================================================
// DECLARATION LOADING (mca_catalog.events, written by sync-mcas)
// ============================================================================

export interface DeclaredEvent {
  topic: string;
  description?: string;
  payload?: Record<string, string>;
  /** Declarative filter fields (events.json). Absent = event is not filterable. */
  filters?: DeclaredEventFilters;
}

interface CatalogEntry {
  events?: DeclaredEvent[];
}

async function loadDeclaredEvents(db: Db, mcaId: string): Promise<Map<string, DeclaredEvent>> {
  const entry = await db
    .collection<CatalogEntry>('mca_catalog')
    .findOne({ mcaId }, { projection: { events: 1 } });
  const map = new Map<string, DeclaredEvent>();
  for (const ev of entry?.events ?? []) map.set(ev.topic, ev);
  return map;
}

// ============================================================================
// VALIDATION
// ============================================================================

const TOPIC_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;

/**
 * Resolve the topic: the tool sends the LOCAL event name ('email.received');
 * the backend maps it to the full bus topic by matching the caller's declared
 * events on the segment after the app's namespace. A full topic
 * ('gmail.email.received') is accepted verbatim when it is declared.
 */
function resolveTopic(declared: Map<string, DeclaredEvent>, raw: string): { topic: string; event: DeclaredEvent } {
  const wanted = String(raw ?? '').trim();
  if (!wanted) {
    throw new McaActionError('INVALID_INPUT', 'event is required (the local event name, e.g. "email.received")', 400);
  }
  // Exact full topic declared → use as-is.
  if (declared.has(wanted)) return { topic: wanted, event: declared.get(wanted)! };
  // Local name → match the suffix of a declared topic ('email.received' matches
  // 'gmail.email.received'). Ambiguity is impossible in practice (one app, one
  // namespace) but resolved deterministically: first declared match.
  for (const [topic, event] of declared) {
    if (topic.endsWith(`.${wanted}`)) return { topic, event };
  }
  const declaredList = [...declared.keys()];
  throw new McaActionError(
    'UNDECLARED_EVENT',
    `Event "${wanted}" is not declared by this app. Declared events: ${declaredList.join(', ') || '(none)'}`,
    404,
    'Use the local event name from the app\'s event list (e.g. "email.received"), or a declared full topic.',
  );
}

/**
 * Validate a unified filter against the event's declared filters block.
 * Fields are AND-ed, values within a field OR-ed; every field must be
 * declared. wakeUpOn entries must be declared event types (local or full).
 */
function validateFilter(
  event: DeclaredEvent,
  filter: unknown,
): { filter?: UnifiedFilter; wakeUpOn?: string[] } {
  if (filter === undefined || filter === null) return {};
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new McaActionError('INVALID_INPUT', 'filter must be an object of { field: value | values[] }', 400);
  }
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.length === 0) return {};
  const spec: DeclaredEventFilters = event.filters ?? {};
  const declaredFields = Object.keys(spec);
  if (declaredFields.length === 0) {
    throw new McaActionError(
      'INVALID_FILTER',
      `Event "${event.topic}" declares no filter fields — subscribe without a filter to receive every occurrence.`,
      400,
    );
  }
  const clean: UnifiedFilter = {};
  for (const [field, value] of entries) {
    const decl = spec[field];
    if (!decl) {
      throw new McaActionError(
        'INVALID_FILTER',
        `Unknown filter field "${field}" for event "${event.topic}". Valid fields: ${declaredFields.join(', ')}`,
        400,
        `Use only the declared fields: ${declaredFields.join(', ')}.`,
      );
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) continue; // empty array = no constraint on this field
    if (values.some((v) => typeof v !== decl.type)) {
      throw new McaActionError(
        'INVALID_FILTER',
        `Filter field "${field}" expects ${decl.type} values (got ${values.map((v) => typeof v).join(', ')})`,
        400,
      );
    }
    clean[field] = Array.isArray(value) ? values : values[0];
  }
  return { filter: Object.keys(clean).length > 0 ? clean : undefined };
}

// ============================================================================
// ACTIONS
// ============================================================================

/** Subscribe the calling conversation (or an explicit channelId) to one event. */
export const subscribe: McaActionHandler = async (ctx: McaActionCtx, db: Db, body: Record<string, unknown>) => {
  const channelId = pickChannelId(ctx, body);
  const declared = await loadDeclaredEvents(db, ctx.mcaId);
  if (declared.size === 0) {
    throw new McaActionError(
      'UNDECLARED_EVENT',
      'This app declares no events — there is nothing to subscribe to.',
      404,
    );
  }
  const { topic, event } = resolveTopic(declared, body.event as string);

  // wakeUpOn: LOCAL event names from the same app, resolved to full topics.
  let wakeUpOn: string[] | undefined;
  const rawWake = body.wakeUpOn;
  if (rawWake !== undefined && rawWake !== null) {
    if (!Array.isArray(rawWake) || rawWake.some((w) => typeof w !== 'string')) {
      throw new McaActionError('INVALID_INPUT', 'wakeUpOn must be an array of event names', 400);
    }
    wakeUpOn = (rawWake as string[]).map((w) => resolveTopic(declared, w).topic);
    if (wakeUpOn.length === 0) wakeUpOn = undefined;
  }

  const { filter } = validateFilter(event, body.filter);

  const mode = body.mode === 'notify' ? 'notify' : 'wake';
  const sub = await getSubscriptionService(db).createChannelSubscription({
    topic,
    channelId,
    mode,
    filter,
    filterSpec: event.filters,
    wakeUpOn,
  });

  return {
    subscription: {
      subscriptionId: sub.id,
      topic: sub.topic,
      event: localName(sub.topic),
      channelId: sub.channelId,
      mode: sub.mode,
      filter: sub.filter ?? {},
      wakeUpOn: sub.wakeUpOn ?? [],
      createdAt: sub.createdAt,
    },
    message: `Subscribed to ${sub.topic}. Matching events are delivered to this conversation${
      mode === 'wake' ? ' and wake its agent' : ''
    } (self-wake guard applies).`,
  };
};

/** Cancel a subscription by id (or all of the channel's on a topic). */
export const unsubscribe: McaActionHandler = async (ctx: McaActionCtx, db: Db, body: Record<string, unknown>) => {
  const svc = getSubscriptionService(db);
  const id = typeof body.subscriptionId === 'string' ? body.subscriptionId : null;
  if (id) {
    const col = db.collection('subscriptions_channel');
    const sub = await col.findOne({ id });
    if (!sub) return { unsubscribed: false, message: `No subscription ${id}` };
    await col.deleteOne({ id });
    return { unsubscribed: true, subscriptionId: id };
  }
  // No id → unsubscribe the channel from a topic (or every topic of this app).
  const channelId = pickChannelId(ctx, body, true);
  const declared = await loadDeclaredEvents(db, ctx.mcaId);
  const rawTopic = typeof body.event === 'string' ? body.event : null;
  let topic: string | null = null;
  if (rawTopic) topic = resolveTopic(declared, rawTopic).topic;
  const col = db.collection('subscriptions_channel');
  const query: Record<string, unknown> = { channelId };
  if (topic) query.topic = topic;
  else if (declared.size > 0) query.topic = { $in: [...declared.keys()] };
  const result = await col.deleteMany(query);
  return { unsubscribed: result.deletedCount > 0, deleted: result.deletedCount, channelId };
};

/**
 * Does ANY channel subscribe to one of this app's events? Used by apps whose
 * event production has a cost (the gmail watcher's polling loop) to run their
 * producer only while someone is listening. The topic must be declared by the
 * calling app — same allowlist as subscribe.
 */
export const hasSubscribers: McaActionHandler = async (ctx: McaActionCtx, db: Db, body: Record<string, unknown>) => {
  const declared = await loadDeclaredEvents(db, ctx.mcaId);
  const { topic } = resolveTopic(declared, (body.topic ?? body.event) as string);
  const col = db.collection('subscriptions_channel');
  const count = await col.countDocuments({ topic });
  return { topic, hasSubscribers: count > 0, subscriberCount: count };
};

/** List the channel's subscriptions to this app's events. */
export const list: McaActionHandler = async (ctx: McaActionCtx, db: Db, body: Record<string, unknown>) => {
  const channelId = pickChannelId(ctx, body);
  const declared = await loadDeclaredEvents(db, ctx.mcaId);
  const col = db.collection('subscriptions_channel');
  const docs = await col.find({ channelId }).toArray();
  const subs = (docs as Array<Record<string, unknown>>)
    .filter((d) => typeof d.topic === 'string' && declared.has(d.topic as string))
    .map((d) => ({
      subscriptionId: d.id,
      topic: d.topic,
      event: localName(d.topic as string),
      channelId: d.channelId,
      mode: d.mode,
      filter: d.filter ?? {},
      wakeUpOn: d.wakeUpOn ?? [],
      createdAt: d.createdAt,
    }));
  return { subscriptions: subs, events: [...declared.values()].map(summarizeEvent) };
};

/** Event summary for the list response (what the agent can subscribe to). */
function summarizeEvent(ev: DeclaredEvent): Record<string, unknown> {
  return {
    event: localName(ev.topic),
    topic: ev.topic,
    description: ev.description ?? '',
    payload: ev.payload ?? {},
    filters: ev.filters ?? {},
  };
}

/** Last segment of a full topic: 'gmail.email.received' → 'email.received'. */
function localName(topic: string): string {
  const parts = topic.split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : topic;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * The conversation that receives the events: the explicit channelId from the
 * body, or the calling agent's channel (ctx.channelId — the verified callback
 * URL segment, not forgeable). One of the two must be present.
 */
function pickChannelId(ctx: McaActionCtx, body: Record<string, unknown>, require = false): string {
  const explicit = typeof body.channelId === 'string' ? body.channelId : null;
  const channelId = explicit ?? ctx.channelId ?? null;
  if (!channelId && require) {
    throw new McaActionError('INVALID_INPUT', 'A channelId is required (explicit or from the calling conversation)', 400);
  }
  if (!channelId) {
    throw new McaActionError(
      'INVALID_INPUT',
      'A channelId is required to subscribe.',
      400,
      'Pass channelId, or call this from an agent conversation (its channel is used).',
    );
  }
  return channelId;
}

/**
 * The subscription service. Constructed per-call against the Db — the service
 * is a thin stateless wrapper over the subscriptions_channel collection (its
 * dispatch-time collaborators are injected elsewhere), so per-call
 * construction is safe and keeps this capability self-contained.
 */
import { MCAEventSubscriptionService } from '../services/mca-event-subscription-service';
function getSubscriptionService(db: Db): MCAEventSubscriptionService {
  return new MCAEventSubscriptionService(db);
}

// ============================================================================
// CAPABILITY REGISTRATION
// ============================================================================

/**
 * SHARED capability — unlike per-mcaId capabilities this one is available to
 * every MCA that declares events; the handlers enforce the declaration
 * allowlist themselves (resolveTopic throws UNDECLARED_EVENT otherwise).
 * The dispatcher special-cases mcaId '*' — see mca-actions/index.ts.
 */
export const subscriptionsCapability = {
  mcaId: '*',
  actions: {
    subscribe,
    unsubscribe,
    list,
    'has-subscribers': hasSubscribers,
  } satisfies Record<string, McaActionHandler>,
};
