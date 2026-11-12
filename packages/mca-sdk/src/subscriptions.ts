/**
 * Reserved subscription tools (v1.4.4) — the ONE subscription API.
 *
 * Every MCA that declares events gets three reserved tools, registered with a
 * leading hyphen exactly like '-health-check' (private in the permissions UI,
 * visible to the LLM as `<app>__subscribe` after the flat-name flattening):
 *
 *   -subscribe             gmail__subscribe(event: 'email.received', filter?)
 *   -unsubscribe           gmail__unsubscribe(event? | subscriptionId?)
 *   -list-subscriptions    gmail__list_subscriptions()
 *
 * The tool takes the LOCAL event name (no app prefix — the namespace is
 * implicit in the tool's own app); the BACKEND resolves it to the full bus
 * topic ('gmail.email.received') by matching the app's declared events, so
 * the mapping lives in one place and the bus convention stays untouched.
 *
 * The MCA holds NO state: the handler forwards to the shared backend
 * capability `subscriptions/<action>` through the authenticated callback
 * (context.backend.invokeAction), where the subscription is validated against
 * the app's declaration (events.json → mca_catalog), persisted in
 * subscriptions_channel and served by the generic dispatch (wake/notify with
 * self-wake guard). A subscription survives the MCA's spawn/despawn cycle by
 * construction — nothing about it lives in this process.
 *
 * Usage (MCA index.ts):
 *   import { registerSubscriptionTools, loadEventsDeclaration } from '@teros/mca-sdk';
 *   registerSubscriptionTools(server, loadEventsDeclaration()); // no-op without events
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { McaServer } from './server';

// ============================================================================
// DECLARATION LOADING (events.json — same pattern as tools.json)
// ============================================================================

export interface DeclaredFilterField {
  type: 'string' | 'number' | 'boolean';
  operator?: 'anyOf' | 'equals' | 'contains';
  mapsTo?: string;
  description?: string;
}

export interface DeclaredEvent {
  topic: string;
  description?: string;
  payload?: Record<string, string>;
  filters?: Record<string, DeclaredFilterField>;
}

export interface EventsDeclaration {
  mcaId?: string;
  events: DeclaredEvent[];
}

/**
 * Load the MCA's events.json (next to manifest.json / tools.json). Returns an
 * empty declaration when the file is absent — an MCA without events simply
 * gets no subscription tools. Invalid JSON throws: a broken declaration must
 * not silently degrade into "no events".
 */
export function loadEventsDeclaration(entrypointDir?: string): EventsDeclaration {
  // entrypointDir is the MCA's own directory — pass
  // dirname(fileURLToPath(import.meta.url)) from the MCA's index.ts. Without
  // it we fall back to the SDK module's directory, which is only correct when
  // the SDK is symlinked beside the MCA (dev); production containers copy the
  // tree so the layout holds. cwd is the last resort.
  let dir = entrypointDir;
  if (!dir) {
    try {
      dir = dirname(fileURLToPath(import.meta.url));
    } catch {
      dir = process.cwd();
    }
  }
  // events.json lives at the MCA ROOT (next to manifest.json / tools.json),
  // while the entrypoint is usually src/index.ts (or dist/index.js). Walk up
  // a couple of levels to find it; stop early at the first events.json.
  const candidates = [join(dir, 'events.json'), join(dir, '..', 'events.json'), join(dir, '..', '..', 'events.json')];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return { events: [] };
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const events = Array.isArray(raw?.events) ? (raw.events as DeclaredEvent[]) : [];
  return { mcaId: raw?.mcaId, events };
}

// ============================================================================
// TOOL SCHEMAS (built from the declaration — declarative, not hardcoded)
// ============================================================================

/** Local name of a declared topic: 'gmail.email.received' → 'email.received'. */
function localName(topic: string): string {
  const parts = topic.split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : topic;
}

/** JSON schema for the filter parameter, from the event's declared filters. */
function filterSchema(ev: DeclaredEvent): Record<string, unknown> | undefined {
  const filters = ev.filters ?? {};
  const fields = Object.keys(filters);
  if (fields.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const decl = filters[field];
    properties[field] = {
      type: decl.type,
      description: decl.description ?? `Filter on ${decl.mapsTo ?? field} (${decl.operator ?? 'anyOf'}).`,
      ...(decl.operator === 'contains' ? {} : {}),
    };
  }
  return {
    type: 'object',
    description:
      `Optional filter — fields are AND-ed, values within a field OR-ed. Valid fields: ${fields.join(', ')}.`,
    properties,
  };
}

function eventEnum(events: DeclaredEvent[]): { enum: string[]; description: string } {
  return {
    enum: events.map((ev) => localName(ev.topic)),
    description: `Local event name (the app namespace is implicit). Valid: ${events
      .map((ev) => `${localName(ev.topic)} — ${ev.description ?? ''}`)
      .join('; ')}`,
  };
}

// ============================================================================
// REGISTRATION
// ============================================================================

/**
 * Register the three reserved subscription tools on the server. No-op when
 * the declaration has no events (an MCA with nothing to subscribe to gets no
 * tools). One subscription per (channel, topic): subscribing again replaces
 * the previous filter — enforced backend-side.
 */
export function registerSubscriptionTools(server: McaServer, declaration: EventsDeclaration): void {
  const events = declaration.events ?? [];
  if (events.length === 0) return;

  const topics = events.map((ev) => localName(ev.topic));

  server.tool('-subscribe', {
    annotations: { readOnlyHint: false, idempotentHint: true },
    description:
      `Subscribe this conversation to one of this app's events (${topics.join(', ')}). ` +
      'Matching events are delivered here as they happen and wake the agent (self-wake guard: an agent is never woken by an event it caused itself). ' +
      'The subscription lives in the backend — it survives restarts of this app. Subscribing again to the same event REPLACES the previous filter. ' +
      'Returns: { subscription: { subscriptionId, topic, event, channelId, mode, filter, wakeUpOn, createdAt }, message }.',
    parameters: {
      type: 'object',
      properties: {
        event: eventEnum(events),
        filter: {
          type: 'object',
          description:
            'Optional filter. Fields AND-ed, values within a field OR-ed. Only the fields declared for the event are valid — see the event list.',
        },
        wakeUpOn: {
          type: 'array',
          items: { type: 'string', enum: topics },
          description:
            'Event names that wake the agent (response turn). Default: the subscribed event always wakes. Rarely needed with a single-event subscription.',
        },
        channelId: {
          type: 'string',
          description: 'Conversation that receives the events. Defaults to the calling conversation — omit it.',
        },
        mode: {
          type: 'string',
          enum: ['notify', 'wake'],
          description: 'notify = silent delivery, wake = trigger an agent response turn. Default: wake.',
        },
      },
      required: ['event'],
    },
    handler: async (args: Record<string, unknown>, context: any) => {
      const backend = context?.backend;
      if (!backend) {
        throw new Error('[NO_BACKEND_CONTEXT] subscriptions require the backend callback (no callbackUrl in execution context).');
      }
      const { workspaceId: _ignored, ...body } = args as Record<string, unknown>;
      return await backend.invokeAction('subscriptions/subscribe', body);
    },
  });

  server.tool('-unsubscribe', {
    annotations: { readOnlyHint: false, idempotentHint: true },
    description:
      'Cancel this conversation\'s subscription(s) to this app\'s events. By subscriptionId, by event name, or — with neither — ALL of this conversation\'s subscriptions to this app. Idempotent. Returns: { unsubscribed, deleted?, channelId }.',
    parameters: {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', description: 'Specific subscription to cancel (from -list-subscriptions).' },
        event: { type: 'string', enum: topics, description: 'Cancel the subscription to this event.' },
        channelId: { type: 'string', description: 'Defaults to the calling conversation.' },
      },
    },
    handler: async (args: Record<string, unknown>, context: any) => {
      const backend = context?.backend;
      if (!backend) {
        throw new Error('[NO_BACKEND_CONTEXT] subscriptions require the backend callback (no callbackUrl in execution context).');
      }
      const { workspaceId: _ignored, ...body } = args as Record<string, unknown>;
      return await backend.invokeAction('subscriptions/unsubscribe', body);
    },
  });

  server.tool('-list-subscriptions', {
    annotations: { readOnlyHint: true, idempotentHint: true },
    description:
      'List this conversation\'s subscriptions to this app\'s events, plus the app\'s event catalog (events, payload fields and valid filter fields) to subscribe to. Returns: { subscriptions: [...], events: [...] }.',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Defaults to the calling conversation.' },
      },
    },
    handler: async (args: Record<string, unknown>, context: any) => {
      const backend = context?.backend;
      if (!backend) {
        throw new Error('[NO_BACKEND_CONTEXT] subscriptions require the backend callback (no callbackUrl in execution context).');
      }
      const { workspaceId: _ignored, ...body } = args as Record<string, unknown>;
      return await backend.invokeAction('subscriptions/list', body);
    },
  });
}
