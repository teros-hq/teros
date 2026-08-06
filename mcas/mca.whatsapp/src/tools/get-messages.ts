import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: GET /api/messages?chatId=&session=&limit=&downloadMedia= (all query params)
export const getMessages: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get recent messages from a WhatsApp chat.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      chatId: {
        type: 'string',
        description: 'Chat ID (e.g. 34612345678@c.us)',
      },
      limit: {
        type: 'number',
        description: 'Max messages to return (default: 20, max: 100)',
      },
      downloadMedia: {
        type: 'boolean',
        description: 'Download media files (default: false)',
      },
      offset: {
        type: 'number',
        description: 'Number of messages to skip (for pagination)',
      },
      'filter.timestamp.lte': {
        type: 'number',
        description: 'Filter messages with timestamp <= this value (Unix timestamp)',
      },
      'filter.timestamp.gte': {
        type: 'number',
        description: 'Filter messages with timestamp >= this value (Unix timestamp)',
      },
      'filter.fromMe': {
        type: 'boolean',
        description: 'Filter messages by direction: true = sent by me, false = received',
      },
      sortBy: {
        type: 'string',
        description: 'Field to sort by (e.g. "timestamp")',
      },
      sortOrder: {
        type: 'string',
        description: 'Sort order: "asc" or "desc"',
      },
      // @todo alice - 2026.04.25 : consider defaulting sortBy=timestamp&sortOrder=desc
      // at the handler level so callers always get newest-first without specifying it
    },
    required: ['chatId'],
  },
  handler: async (args) => {
    const {
      session = 'default',
      chatId,
      limit = 20,
      downloadMedia = false,
      offset,
      'filter.timestamp.lte': filterTsLte,
      'filter.timestamp.gte': filterTsGte,
      'filter.fromMe': filterFromMe,
      sortBy,
      sortOrder,
    } = args as {
      session?: string;
      chatId: string;
      limit?: number;
      downloadMedia?: boolean;
      offset?: number;
      'filter.timestamp.lte'?: number;
      'filter.timestamp.gte'?: number;
      'filter.fromMe'?: boolean;
      sortBy?: string;
      sortOrder?: string;
    };
    // Spec: GET /api/messages?chatId=&session=&limit=&downloadMedia=
    const params = new URLSearchParams({
      chatId,
      session,
      limit: String(limit),
      downloadMedia: String(downloadMedia),
    });
    if (offset !== undefined) params.set('offset', String(offset));
    if (filterTsLte !== undefined) params.set('filter.timestamp.lte', String(filterTsLte));
    if (filterTsGte !== undefined) params.set('filter.timestamp.gte', String(filterTsGte));
    if (filterFromMe !== undefined) params.set('filter.fromMe', String(filterFromMe));
    if (sortBy !== undefined) params.set('sortBy', sortBy);
    if (sortOrder !== undefined) params.set('sortOrder', sortOrder);
    const res = await wahaFetch(`/messages?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    const raw = await res.json();
    const items = Array.isArray(raw) ? raw : [];
    // Strip _data and other large internal fields to avoid hitting output size limits
    return items.map((msg: Record<string, unknown>) => ({
      id: msg.id,
      timestamp: msg.timestamp,
      from: msg.from,
      fromMe: msg.fromMe,
      body: msg.body,
      type: msg.type,
      hasMedia: msg.hasMedia,
      ack: msg.ack,
      ackName: msg.ackName,
      replyTo: msg.replyTo ?? null,
    }));
  },
};
