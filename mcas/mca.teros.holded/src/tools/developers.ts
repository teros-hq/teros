import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw webhook shape returned by the Holded API */
interface HoldedWebhook {
  id?: string;
  _id?: string;
  url?: string;
  events?: string[];
  enabled?: boolean;
  secret?: string;
  created_at?: string;
  updated_at?: string;
}

/** Curated webhook output returned by our tools */
interface CuratedWebhook {
  id: string | null;
  url: string | null;
  events: string[] | null;
  enabled: boolean | null;
  secret: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapWebhook(w: HoldedWebhook): CuratedWebhook {
  return {
    id: w.id ?? w._id ?? null,
    url: w.url ?? null,
    events: w.events ?? null,
    enabled: w.enabled ?? null,
    secret: w.secret ?? null,
    createdAt: w.created_at ?? null,
    updatedAt: w.updated_at ?? null,
  };
}

// =============================================================================
// GET API USAGE
// =============================================================================

export const getApiUsage: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get API usage statistics for the current Holded account. Shows request counts, rate limit info, and overall usage.',
  parameters: {
    type: 'object',
    properties: {
      startDate: {
        type: 'string',
        description: 'Start date for usage period (ISO 8601, e.g. 2026-01-01)',
      },
      endDate: {
        type: 'string',
        description: 'End date for usage period (ISO 8601, e.g. 2026-12-31)',
      },
    },
  },
  handler: async (args, context) => {
    const { startDate, endDate } = args as {
      startDate?: string;
      endDate?: string;
    };

    const params: Record<string, string> = {};
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;

    const data = (await holdedRequest(context, '/v2/usage', {
      params: Object.keys(params).length ? params : undefined,
    })) as any;

    return {
      usage: data.usage ?? data.requests ?? data ?? null,
      period: data.period ?? null,
      rateLimit: data.rate_limit ?? null,
      byType: data.by_type ?? data.types ?? null,
    };
  },
};

// =============================================================================
// GET API USAGE BY TYPE
// =============================================================================

export const getApiUsageByType: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get API usage statistics broken down by a specific type (e.g. "requests", "errors"). Returns usage details for the given type.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'The usage type to filter by (e.g. "requests", "errors")',
      },
      startDate: {
        type: 'string',
        description: 'Start date for usage period (ISO 8601, e.g. 2026-01-01)',
      },
      endDate: {
        type: 'string',
        description: 'End date for usage period (ISO 8601, e.g. 2026-12-31)',
      },
    },
    required: ['type'],
  },
  handler: async (args, context) => {
    const { type, startDate, endDate } = args as {
      type: string;
      startDate?: string;
      endDate?: string;
    };

    const params: Record<string, string> = {};
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;

    const data = (await holdedRequest(
      context,
      `/v2/usage/${encodeURIComponent(type)}`,
      {
        params: Object.keys(params).length ? params : undefined,
      },
    )) as any;

    return {
      type,
      usage: data.usage ?? data.requests ?? data ?? null,
      period: data.period ?? null,
      details: data.details ?? data.breakdown ?? null,
    };
  },
};

// =============================================================================
// LIST WEBHOOKS
// =============================================================================

export const listWebhooks: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all webhooks configured in Holded. Webhooks are HTTP callbacks that notify your application when events occur.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const data = (await holdedRequest(context, '/v2/webhooks')) as any;

    const webhooks = Array.isArray(data) ? data : (data?.items ?? []);

    return {
      webhooks: webhooks.map(mapWebhook),
      count: webhooks.length,
    };
  },
};

// =============================================================================
// GET WEBHOOK
// =============================================================================

export const getWebhook: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single webhook from Holded by its ID. Returns full webhook details including URL, subscribed events, and enabled status.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded webhook ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/webhooks/${encodeURIComponent(id)}`,
    )) as HoldedWebhook;

    return mapWebhook(data);
  },
};

// =============================================================================
// CREATE WEBHOOK
// =============================================================================

export const createWebhook: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new webhook in Holded. The webhook will receive HTTP POST callbacks for the specified events at the given URL.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL where webhook events will be delivered (must be HTTPS)',
      },
      events: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Array of event types to subscribe to (e.g. ["contact.created", "invoice.paid"]). Use list-webhook-events to see available events.',
      },
    },
    required: ['url', 'events'],
  },
  handler: async (args, context) => {
    const { url, events } = args as { url: string; events: string[] };

    const body: Record<string, unknown> = { url, events };

    const data = (await holdedRequest(context, '/v2/webhooks', {
      method: 'POST',
      body,
    })) as HoldedWebhook;

    return mapWebhook(data);
  },
};

// =============================================================================
// UPDATE WEBHOOK
// =============================================================================

export const updateWebhook: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing webhook in Holded. Can modify the URL, subscribed events, or enabled status.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded webhook ID',
      },
      url: {
        type: 'string',
        description: 'The new URL where webhook events will be delivered (must be HTTPS)',
      },
      events: {
        type: 'array',
        items: { type: 'string' },
        description: 'New array of event types to subscribe to',
      },
      enabled: {
        type: 'boolean',
        description: 'Enable or disable the webhook',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id, url, events, enabled } = args as {
      id: string;
      url?: string;
      events?: string[];
      enabled?: boolean;
    };

    const body: Record<string, unknown> = {};
    if (url) body.url = url;
    if (events) body.events = events;
    if (enabled !== undefined) body.enabled = enabled;

    const data = (await holdedRequest(
      context,
      `/v2/webhooks/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as HoldedWebhook;

    return mapWebhook(data);
  },
};

// =============================================================================
// DELETE WEBHOOK
// =============================================================================

export const deleteWebhook: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete a webhook from Holded by its ID. This permanently removes the webhook and stops all event deliveries to its URL.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded webhook ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { id, deleted: true };
  },
};

// =============================================================================
// LIST WEBHOOK EVENTS
// =============================================================================

export const listWebhookEvents: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all supported webhook event types in Holded. Use this to discover which events you can subscribe to when creating or updating webhooks.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const data = (await holdedRequest(context, '/v2/webhooks/events')) as any;

    const events = Array.isArray(data) ? data : (data?.events ?? data?.items ?? []);

    return {
      events: events.map((e: any) =>
        typeof e === 'string' ? e : (e.name ?? e.event ?? e.type ?? String(e)),
      ),
      count: events.length,
    };
  },
};
